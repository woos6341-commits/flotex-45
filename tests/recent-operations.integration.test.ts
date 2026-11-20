import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { requests, users } from "../drizzle/schema";
import { getDb, getUserByOpenId, upsertUser } from "../server/db";
import { getRecentOperations } from "../server/recent-operations";
import { ADMIN_EMAIL } from "../shared/admin";

const isolatedIt = process.env.FLOTEX_ISOLATED_TEST_DB === "1" ? it : it.skip;
const requestReferences: string[] = [];
const userIds: number[] = [];

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  if (requestReferences.length) await db.delete(requests).where(inArray(requests.reference, requestReferences));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

describe("unified recent operations pagination on isolated DB", () => {
  isolatedIt("returns oldest pending items first, pages forward, and exposes final decision metadata", async () => {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) throw new Error("DATABASE_URL is required for the isolated request-center test.");
    const target = new URL(rawUrl);
    if (target.hostname !== "127.0.0.1" || !target.pathname.startsWith("/flotex_test_")) {
      throw new Error("Refusing request-center test outside a loopback flotex_test_* database.");
    }
    const suffix = randomUUID();
    const adminOpenId = `request-center-admin:${suffix}`;
    const userOpenId = `request-center-user:${suffix}`;
    await upsertUser({ openId: adminOpenId, name: "مسؤول أرشيف اختباري", role: "admin", email: ADMIN_EMAIL, loginMethod: "test" });
    await upsertUser({ openId: userOpenId, name: "عميل أرشيف اختباري", loginMethod: "test" });
    const admin = await getUserByOpenId(adminOpenId);
    const customer = await getUserByOpenId(userOpenId);
    if (!admin || !customer) throw new Error("Could not create request-center fixtures.");
    userIds.push(admin.id, customer.id);
    const references = [`RC-PENDING-OLD-${suffix}`, `RC-PENDING-NEW-${suffix}`, `RC-APPROVED-${suffix}`];
    requestReferences.push(...references);
    const db = await getDb();
    if (!db) throw new Error("The isolated request-center database is unavailable.");
    await db.insert(requests).values([
      { reference: references[0]!, userId: customer.id, type: "deposit", amount: "10.00", status: "pending", createdAt: new Date("2000-01-01T00:00:00.000Z") },
      { reference: references[1]!, userId: customer.id, type: "deposit", amount: "12.00", status: "pending", createdAt: new Date("2001-01-01T00:00:00.000Z") },
      { reference: references[2]!, userId: customer.id, type: "deposit", amount: "14.00", status: "approved", reviewedBy: admin.id, reviewedAt: new Date("2002-01-01T00:00:00.000Z"), createdAt: new Date("1999-01-01T00:00:00.000Z") },
    ]);

    const firstPendingPage = await getRecentOperations({ limit: 1, offset: 0, pendingOnly: true });
    const secondPendingPage = await getRecentOperations({ limit: 1, offset: 1, pendingOnly: true });
    expect(firstPendingPage[0]?.reference).toBe(references[0]);
    expect(secondPendingPage[0]?.reference).toBe(references[1]);
    const searched = await getRecentOperations({ limit: 1, pendingOnly: true, search: references[1] });
    expect(searched.map((item) => item.reference)).toEqual([references[1]]);
    const searchedByType = await getRecentOperations({ limit: 10, pendingOnly: true, search: "إيداع" });
    expect(searchedByType.map((item) => item.reference)).toEqual([references[0], references[1]]);
    const archivedPage = await getRecentOperations({ limit: 1, offset: 0, historyOnly: true });
    expect(archivedPage[0]).toMatchObject({
      reference: references[2],
      status: "approved",
      decisionByName: "مسؤول أرشيف اختباري",
    });
    expect(archivedPage[0]?.decisionAt).toBeTruthy();
  });
});
