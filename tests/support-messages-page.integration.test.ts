import { randomInt, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { supportMessages, supportThreadStates, users } from "../drizzle/schema";
import { encryptAccountVerificationDocument } from "../server/account-verification-crypto";
import { getDb } from "../server/db";
import { listAdminSupportMessages, listMySupportMessages } from "../server/support-messages";
import { ADMIN_EMAIL } from "../shared/admin";

// Never opt into a database automatically. Only synthetic fixtures are inserted,
// and this test deliberately does not delete any rows or alter thread state.
const isolated = process.env.FLOTEX_ISOLATED_TEST_DB === "1" && process.env.FLOTEX_RUN_LOCAL_DB_TESTS === "1" && process.env.FLOTEX_RUN_SUPPORT_PAGE_INTEGRATION === "1" ? describe : describe.skip;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
let db: Db;

async function fixtureUser(role: "user" | "admin" = "user") {
  const openId = `support-page:${randomUUID()}`;
  const customerId = String(randomInt(1, 10_000_000_000)).padStart(10, "0");
  const email = role === "admin" ? ADMIN_EMAIL : `${randomUUID()}@example.test`;
  await db.execute(sql`INSERT INTO users (openId, customerId, name, email, role) VALUES (${openId}, ${customerId}, ${"Synthetic"}, ${email}, ${role})`);
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.openId, openId));
  return row.id;
}

const time = new Date("2021-02-03T04:05:06Z");
const earlierRead = new Date("2022-01-01T00:00:00Z");

isolated("support message pages on isolated local database", () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    const database = decodeURIComponent(target.pathname.slice(1));
    if (target.hostname !== "127.0.0.1" || !/^flotex_test_[a-zA-Z0-9_]+$/.test(database)) {
      throw new Error("Refusing non-isolated test database");
    }
    const connection = await getDb();
    if (!connection) throw new Error("Local test database required");
    db = connection;
  });

  it.each([0, 1, 199, 200, 201, 450])("returns the latest ordered page for %i messages", async (count) => {
    const userId = await fixtureUser();
    if (count) await db.insert(supportMessages).values(Array.from({ length: count }, (_, i) => ({
      userId, category: "account" as const, senderRole: "admin" as const,
      body: `message-${i}`, createdAt: i === 0 ? new Date("2021-03-01T00:00:00Z") : time,
    })));
    const all = await db.select().from(supportMessages).where(eq(supportMessages.userId, userId));
    const sorted = [...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    const expected = sorted.slice(-200);
    const page = await listMySupportMessages(userId, "account");
    expect(page.map((message) => message.id)).toEqual(expected.map((row) => row.id));
    expect(page.every((message) => message.readAt !== null)).toBe(true);
    const after = await db.select().from(supportMessages).where(eq(supportMessages.userId, userId));
    const pageIds = new Set(page.map((message) => message.id));
    expect(after).toHaveLength(count);
    for (const row of after) expect(row.readAt !== null).toBe(pageIds.has(row.id));
  });

  it.each(["account", "freeze", "external_transaction"] as const)("isolates %s messages for user and admin and preserves thread state", async (category) => {
    const userId = await fixtureUser();
    const otherUserId = await fixtureUser();
    const adminId = await fixtureUser("admin");
    await db.insert(supportThreadStates).values({ userId, category, status: "closed", closedBy: adminId, closedAt: time });
    const [stateBefore] = await db.select().from(supportThreadStates).where(and(eq(supportThreadStates.userId, userId), eq(supportThreadStates.category, category)));
    await db.insert(supportMessages).values(Array.from({ length: 240 }, (_, i) => ({
      userId, category, senderRole: i % 2 ? "user" as const : "admin" as const,
      body: `message-${i}`, createdAt: time, readAt: i === 230 ? earlierRead : null,
    })));
    const otherCategory = category === "account" ? "freeze" : "account";
    await db.insert(supportMessages).values([
      { userId, category: otherCategory, senderRole: "admin", body: "another category", createdAt: time },
      { userId: otherUserId, category, senderRole: "user", body: "another user", createdAt: time },
    ]);
    const all = await db.select().from(supportMessages).where(and(eq(supportMessages.userId, userId), eq(supportMessages.category, category)));
    const ordered = [...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    const expected = ordered.slice(-200);
    const expectedIds = new Set(expected.map((row) => row.id));
    const myPage = await listMySupportMessages(userId, category);
    expect(myPage.map((item) => item.id)).toEqual(expected.map((row) => row.id));
    let current = await db.select().from(supportMessages).where(and(eq(supportMessages.userId, userId), eq(supportMessages.category, category)));
    for (const row of current) {
      const original = all.find((item) => item.id === row.id)!;
      const shouldRead = original.readAt !== null || (expectedIds.has(row.id) && row.senderRole === "admin");
      expect(row.readAt !== null).toBe(shouldRead);
      if (original.readAt) expect(row.readAt?.getTime()).toBe(original.readAt.getTime());
    }
    const adminPage = await listAdminSupportMessages(adminId, userId, category);
    expect(adminPage.map((item) => item.id)).toEqual(expected.map((row) => row.id));
    current = await db.select().from(supportMessages).where(and(eq(supportMessages.userId, userId), eq(supportMessages.category, category)));
    for (const row of current) expect(row.readAt !== null).toBe(expectedIds.has(row.id) || all.find((item) => item.id === row.id)!.readAt !== null);
    const unrelatedCategory = await db.select().from(supportMessages).where(and(eq(supportMessages.userId, userId), eq(supportMessages.category, otherCategory)));
    const unrelatedUser = await db.select().from(supportMessages).where(eq(supportMessages.userId, otherUserId));
    expect(unrelatedCategory[0].readAt).toBeNull();
    expect(unrelatedUser[0].readAt).toBeNull();
    const [stateAfter] = await db.select().from(supportThreadStates).where(and(eq(supportThreadStates.userId, userId), eq(supportThreadStates.category, category)));
    expect(stateAfter).toEqual(stateBefore);
    await listMySupportMessages(userId, category);
    const reread = await db.select().from(supportMessages).where(and(eq(supportMessages.userId, userId), eq(supportMessages.category, category)));
    expect(reread).toEqual(current);
    await expect(listAdminSupportMessages(otherUserId, userId, category)).rejects.toThrow();
  });

  it.each(["user", "admin"] as const)("does not mark a message arriving during the %s page fetch", async (viewer) => {
    const userId = await fixtureUser();
    const adminId = await fixtureUser("admin");
    const senderRole = viewer === "user" ? "admin" as const : "user" as const;
    await db.insert(supportMessages).values({ userId, category: "account", senderRole, body: "selected", createdAt: time });
    const originalUpdate = db.update.bind(db);
    const spy = vi.spyOn(db, "update").mockImplementation(((table: any) => {
      const builder = originalUpdate(table);
      const originalSet = builder.set.bind(builder);
      builder.set = ((values: any) => {
        const query = originalSet(values);
        const originalWhere = query.where.bind(query);
        query.where = ((condition: any) => (async () => {
          await db.insert(supportMessages).values({ userId, category: "account", senderRole, body: "arrived after selection" });
          return originalWhere(condition);
        })()) as any;
        return query;
      }) as any;
      return builder;
    }) as any);
    try {
      const page = viewer === "user" ? await listMySupportMessages(userId, "account") : await listAdminSupportMessages(adminId, userId, "account");
      expect(page.map((row) => row.body)).toEqual(["selected"]);
      const all = await db.select().from(supportMessages).where(eq(supportMessages.userId, userId));
      expect(all.find((row) => row.body === "selected")?.readAt).not.toBeNull();
      expect(all.find((row) => row.body === "arrived after selection")?.readAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("retains the response shape and decrypts attachments before acknowledging the page", async () => {
    const userId = await fixtureUser();
    vi.stubEnv("KYC_DOCUMENT_ENCRYPTION_KEY", "test-only-key-for-support-page-1234567890");
    try {
      const bytes = Buffer.from("synthetic image contents");
      await db.insert(supportMessages).values({ userId, category: "account", senderRole: "admin", body: "attachment", createdAt: time, attachmentCiphertext: encryptAccountVerificationDocument(bytes), attachmentMimeType: "image/png" });
      const [message] = await listMySupportMessages(userId, "account");
      const photo = { data: bytes.toString("base64"), mimeType: "image/png" };
      expect(message.attachment).toEqual(photo);
      expect(message.attachments).toEqual([photo]);
      expect(message.readAt).not.toBeNull();
      const [stored] = await db.select().from(supportMessages).where(eq(supportMessages.id, message.id));
      expect(message.readAt?.getTime()).toBe(stored.readAt?.getTime());
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not mark any message if page attachment decoding fails", async () => {
    const userId = await fixtureUser();
    await db.insert(supportMessages).values([
      { userId, category: "account", senderRole: "admin", body: "valid", createdAt: time },
      { userId, category: "account", senderRole: "admin", body: "invalid attachment", createdAt: time, attachmentCiphertext: "invalid", attachmentMimeType: "image/jpeg" },
    ]);
    await expect(listMySupportMessages(userId, "account")).rejects.toThrow();
    const rows = await db.select().from(supportMessages).where(eq(supportMessages.userId, userId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.readAt === null)).toBe(true);
  });
});
