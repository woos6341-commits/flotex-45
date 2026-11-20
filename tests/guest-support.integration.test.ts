import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guestSupportMessages, guestSupportSessions, guestSupportTickets } from "../drizzle/schema";
import { guestSupportAuditEvents, guestSupportMessageOperations, guestSupportRateLimits } from "../drizzle/guest-support-schema";
import { getDb } from "../server/db";
import { hashOpaqueGrant } from "../server/manual-auth-crypto";
import { guestSupportNetworkKey, registerGuestSupportRoutes } from "../server/guest-support";
import { appRouter } from "../server/routers";
import { ADMIN_EMAIL } from "../shared/admin";

// Explicit opt-in AND a hard-coded isolated local target. Never use a service DB.
const isolated = process.env.FLOTEX_GUEST_TEST_DB === "1" ? describe : describe.skip;
let server: Server | undefined;
let baseUrl = "";
let adminId = 0;
let authorizedDb = false;
const ticketIds: number[] = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lp1sAAAAASUVORK5CYII=";
const pdf = Buffer.from("%PDF-1.4\n% synthetic test\n%%EOF\n").toString("base64");

beforeAll(async () => {
  if (process.env.FLOTEX_GUEST_TEST_DB !== "1") return;
  const url = new URL(process.env.DATABASE_URL || "mysql://invalid/invalid");
  if (url.hostname !== "127.0.0.1" || url.port !== "23319" || url.pathname !== "/flotex_test_guest_support" || process.env.FLOTEX_RUN_LOCAL_DB_TESTS !== "1") throw new Error("Refusing to test: dedicated loopback guest-support database required.");
  authorizedDb = true;
  process.env.KYC_DOCUMENT_ENCRYPTION_KEY = "test-only-encryption-key-material-with-32-bytes";
  process.env.GUEST_SUPPORT_RATE_LIMIT_SECRET = "test-only-rate-limit-hmac-secret-32-bytes";
  delete process.env.GUEST_SUPPORT_TRUSTED_PROXY_IPS;
  const db = await getDb(); if (!db) throw new Error("No isolated database");
  const result = await db.execute(sql`insert into users (openId, customerId, role, email, emailNormalized) values (${`guest-test-admin-${randomUUID()}`}, '8888888888', 'admin', ${ADMIN_EMAIL}, ${ADMIN_EMAIL})`);
  adminId = Number((result as any)[0].insertId);
  const app = express(); app.use(express.json({ limit: "5mb" })); registerGuestSupportRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const address = server!.address(); if (!address || typeof address === "string") throw new Error("No local HTTP listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (!authorizedDb) return;
  const db = await getDb(); if (!db) return;
  if (ticketIds.length) {
    await db.delete(guestSupportAuditEvents).where(inArray(guestSupportAuditEvents.ticketId, ticketIds));
    await db.delete(guestSupportMessageOperations).where(inArray(guestSupportMessageOperations.ticketId, ticketIds));
    await db.delete(guestSupportMessages).where(inArray(guestSupportMessages.ticketId, ticketIds));
    await db.delete(guestSupportSessions).where(inArray(guestSupportSessions.ticketId, ticketIds));
    await db.delete(guestSupportTickets).where(inArray(guestSupportTickets.id, ticketIds));
  }
  await db.delete(guestSupportRateLimits).where(inArray(guestSupportRateLimits.rateKey, [guestSupportNetworkKey("create", "127.0.0.1"), guestSupportNetworkKey("message", "127.0.0.1")]));
  if (adminId) await db.execute(sql`delete from users where id = ${adminId}`);
});
function admin() { return appRouter.createCaller({ req: {} as any, res: { setHeader() {} } as any, user: { id: adminId, role: "admin", email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL } as any }); }
async function call(path: string, method = "GET", body?: unknown, token?: string, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, cache: response.headers.get("cache-control"), data: await response.json() as any };
}

isolated("guest support on the dedicated local database", () => {
  it("creates distinct persistent sessions, isolates guests, opens and replies without a user, handles attachments, states, retries, and auditing", async () => {
    const db = await getDb(); if (!db) throw new Error("No DB");
    const a = await call("/api/guest-support/anonymous", "POST");
    const b = await call("/api/guest-support/anonymous", "POST");
    expect(a.status, JSON.stringify(a.data)).toBe(200); expect(b.status, JSON.stringify(b.data)).toBe(200);
    expect(a.data.ticketCode).not.toBe(b.data.ticketCode);
    expect(a.data.guestSupportToken).not.toBe(b.data.guestSupportToken);
    const [ta] = await db.select().from(guestSupportTickets).where(eq(guestSupportTickets.ticketCode, a.data.ticketCode));
    const [tb] = await db.select().from(guestSupportTickets).where(eq(guestSupportTickets.ticketCode, b.data.ticketCode));
    ticketIds.push(ta.id, tb.id);
    const tokA = a.data.guestSupportToken, tokB = b.data.guestSupportToken;
    const initial = await call("/api/guest-support/messages", "POST", { body: "رسالة ألف", operationId: "guest_operation_one_123" }, tokA);
    expect(initial.status).toBe(200);
    expect((await call("/api/guest-support/messages", "POST", { body: "رسالة باء", operationId: "guest_operation_two_123" }, tokB)).status).toBe(200);
    const results = await Promise.all(Array.from({ length: 5 }, () => call("/api/guest-support/messages", "POST", { body: "إعادة المحاولة", operationId: "guest_retry_operation_123" }, tokA)));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(new Set(results.map((result) => result.data.messageId)).size).toBe(1);
    expect((await call("/api/guest-support/messages", "POST", { body: "محتوى مختلف", operationId: "guest_retry_operation_123" }, tokA)).status).toBe(400);
    const privateA = await call(`/api/guest-support/messages?ticketId=${tb.id}`, "GET", undefined, tokA);
    const privateB = await call(`/api/guest-support/messages?ticketId=${ta.id}`, "GET", undefined, tokB);
    expect(privateA.cache).toContain("no-store");
    expect(privateA.data.ticket.ticketCode).toBe(a.data.ticketCode);
    expect(privateA.data.messages.map((m: any) => m.body)).not.toContain("رسالة باء");
    expect(privateB.data.messages.map((m: any) => m.body)).toEqual(["رسالة باء"]);
    expect((await call("/api/guest-support/messages", "GET", undefined, a.data.ticketCode)).status).toBe(400);

    const caller = admin();
    const forbidden = appRouter.createCaller({ req: {} as any, res: { setHeader() {} } as any, user: null });
    await expect(forbidden.admin.guestSupportMessages({ ticketId: ta.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const inbox = await caller.admin.guestSupportTickets();
    expect(inbox.find((i) => i.ticket.id === ta.id)?.ticket.status).toBe("new");
    expect((await caller.admin.guestSupportMessages({ ticketId: ta.id })).map((m) => m.body)).toContain("رسالة ألف");
    expect((await caller.admin.guestSupportMessages({ ticketId: tb.id })).map((m) => m.body)).toEqual(["رسالة باء"]);
    const replyInput = { ticketId: ta.id, body: "رد الإدارة", attachment: { data: png, mimeType: "image/png" as const }, operationId: "admin_retry_operation_123" };
    const replies = await Promise.all(Array.from({ length: 4 }, () => caller.admin.replyGuestSupport(replyInput)));
    expect(new Set(replies.map((item) => item.messageId)).size).toBe(1);
    const aAfterReply = await call("/api/guest-support/messages", "GET", undefined, tokA);
    expect(aAfterReply.data.ticket.status).toBe("replied");
    expect(aAfterReply.data.messages.at(-1).attachment).toEqual({ data: png, mimeType: "image/png" });
    const [savedImage] = await db.select().from(guestSupportMessages).where(eq(guestSupportMessages.id, replies[0].messageId));
    expect(savedImage.attachmentCiphertext).toBeTruthy();
    expect(savedImage.attachmentCiphertext).not.toContain(png);
    expect((await call("/api/guest-support/messages", "POST", { body: "", attachment: { data: pdf, mimeType: "application/pdf" }, operationId: "guest_pdf_operation_123" }, tokA)).status).toBe(200);
    const adminMessages = await caller.admin.guestSupportMessages({ ticketId: ta.id });
    expect(adminMessages.at(-1)?.attachment).toEqual({ data: pdf, mimeType: "application/pdf" });
    expect((await caller.admin.guestSupportTickets()).find((i) => i.ticket.id === ta.id)?.ticket.status).toBe("pending_reply");
    expect((await call("/api/guest-support/messages", "POST", { body: "", attachment: { data: Buffer.from("not pdf").toString("base64"), mimeType: "application/pdf" }, operationId: "invalid_pdf_operation_123" }, tokA)).status).toBe(400);
    await caller.admin.updateGuestSupportStatus({ ticketId: ta.id, status: "closed" });
    expect((await call("/api/guest-support/messages", "POST", { body: "بعد الإغلاق", operationId: "guest_closed_operation_123" }, tokA)).status).toBe(400);
    await expect(caller.admin.replyGuestSupport({ ticketId: ta.id, body: "رد مغلق", operationId: "admin_closed_operation_123" })).rejects.toThrow();
    await caller.admin.updateGuestSupportStatus({ ticketId: ta.id, status: "pending_reply" });
    expect((await call("/api/guest-support/messages", "POST", { body: "بعد إعادة الفتح", operationId: "guest_reopen_operation_123" }, tokA)).status).toBe(200);
    const audit = await db.select().from(guestSupportAuditEvents).where(eq(guestSupportAuditEvents.ticketId, ta.id));
    expect(audit.map((event) => event.action)).toEqual(["reply", "status_change", "status_change"]);
    await caller.admin.replyGuestSupport({ ticketId: ta.id, body: "ملف الإدارة", attachment: { data: pdf, mimeType: "application/pdf" }, operationId: "admin_pdf_operation_12345" });
    const guestPdf = await call("/api/guest-support/messages", "GET", undefined, tokA);
    expect(guestPdf.data.messages.at(-1).attachment).toEqual({ data: pdf, mimeType: "application/pdf" });
    expect(guestPdf.data.ticket.status).toBe("replied");

    // Legacy 30-day anonymous grants retain the same ticket even when expired;
    // revocation still takes precedence over restoration.
    await db.update(guestSupportSessions).set({ expiresAt: new Date("2020-01-01T00:00:00Z") }).where(eq(guestSupportSessions.tokenHash, hashOpaqueGrant(tokA)));
    expect((await call("/api/guest-support/messages", "GET", undefined, tokA)).data.ticket.ticketCode).toBe(a.data.ticketCode);
    await db.update(guestSupportSessions).set({ revokedAt: new Date() }).where(eq(guestSupportSessions.tokenHash, hashOpaqueGrant(tokA)));
    expect((await call("/api/guest-support/messages", "GET", undefined, tokA)).status).toBe(400);
    expect((await call("/api/guest-support/messages", "GET", undefined, tokB)).data.ticket.ticketCode).toBe(b.data.ticketCode);
    for (let index = 0; index < 7; index++) expect((await call("/api/guest-support/messages", "POST", { body: `رسالة اختبار ${index}`, operationId: `guest_limit_operation_${index}123` }, tokB)).status).toBe(200);
    expect((await call("/api/guest-support/messages", "POST", { body: "فوق الحد", operationId: "guest_limit_operation_excess" }, tokB)).status).toBe(400);
  }, 30_000);

  it("does not truncate long conversations or hide other inbox tickets behind a busy thread", async () => {
    const db = await getDb(); if (!db) throw new Error("No DB");
    const a = await call("/api/guest-support/anonymous", "POST"), b = await call("/api/guest-support/anonymous", "POST");
    const [ta] = await db.select().from(guestSupportTickets).where(eq(guestSupportTickets.ticketCode, a.data.ticketCode));
    const [tb] = await db.select().from(guestSupportTickets).where(eq(guestSupportTickets.ticketCode, b.data.ticketCode));
    ticketIds.push(ta.id, tb.id);
    for (let offset = 0; offset < 1100; offset += 100) {
      await db.insert(guestSupportMessages).values(Array.from({ length: 100 }, (_, index) => ({ ticketId: ta.id, senderRole: "admin" as const, body: `synthetic-${offset + index}` })));
    }
    expect((await call("/api/guest-support/messages", "GET", undefined, a.data.guestSupportToken)).data.messages).toHaveLength(1100);
    const inbox = await admin().admin.guestSupportTickets();
    expect(inbox.some((item) => item.ticket.id === ta.id)).toBe(true);
    expect(inbox.some((item) => item.ticket.id === tb.id)).toBe(true);
  }, 30_000);

  it("atomically limits network-wide creation despite spoofed forwarding headers and also limits message requests", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call("/api/guest-support/anonymous", "POST", undefined, undefined, { "x-forwarded-for": `198.51.100.${i + 1}` })));
    const allowed = results.filter((result) => result.status === 200);
    expect(allowed).toHaveLength(2); // four sessions already created in these tests; six per network/window
    expect(results.filter((result) => result.status === 429)).toHaveLength(8);
    const db = await getDb(); if (!db) throw new Error("No DB");
    for (const result of allowed) {
      const [ticket] = await db.select().from(guestSupportTickets).where(eq(guestSupportTickets.ticketCode, result.data.ticketCode));
      ticketIds.push(ticket.id);
    }
    const attempts = await Promise.all(Array.from({ length: 45 }, (_, i) => call("/api/guest-support/messages", "POST", { body: "test", operationId: `request_limit_${i}123456789` }, "wrong-token", { "x-forwarded-for": `203.0.113.${i + 1}` })));
    expect(attempts.some((result) => result.status === 429)).toBe(true);
    expect(attempts.every((result) => result.status === 400 || result.status === 429)).toBe(true);
  }, 30_000);
});
