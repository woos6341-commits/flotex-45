import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { notifications, requests, supportMessages, supportThreadStates, users } from "../drizzle/schema";
import { getDb, getUserByOpenId, upsertUser } from "../server/db";
import { getRecentOperations } from "../server/recent-operations";
import { closeSupportConversation, listAdminSupportConversations, replyToSupportMessage, sendSupportMessage } from "../server/support-messages";
import { ADMIN_EMAIL } from "../shared/admin";

const isolatedIt = process.env.FLOTEX_ISOLATED_TEST_DB === "1" ? it : it.skip;
const userIds: number[] = [];
const requestReferences: string[] = [];

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  if (requestReferences.length) await db.delete(requests).where(inArray(requests.reference, requestReferences));
  if (userIds.length) {
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(supportMessages).where(inArray(supportMessages.userId, userIds));
    await db.delete(supportThreadStates).where(inArray(supportThreadStates.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

describe("support queue on isolated database", () => {
  isolatedIt("uses creation time across conversations and requests and archives only on explicit closure", async () => {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error("isolated DB required");
    const target = new URL(raw);
    if (target.hostname !== "127.0.0.1" || !target.pathname.startsWith("/flotex_test_")) throw new Error("refusing non-isolated DB");
    const suffix = randomUUID();
    const adminOpenId = `support-queue-admin:${suffix}`;
    const customerOpenId = `support-queue-user:${suffix}`;
    await upsertUser({ openId: adminOpenId, name: "مسؤول اختباري", email: ADMIN_EMAIL, loginMethod: "test" });
    await upsertUser({ openId: customerOpenId, name: "عميل اختباري", email: `${suffix}@example.test`, loginMethod: "test" });
    const admin = await getUserByOpenId(adminOpenId);
    const customer = await getUserByOpenId(customerOpenId);
    if (!admin || !customer) throw new Error("fixtures missing");
    userIds.push(admin.id, customer.id);
    const db = await getDb();
    if (!db) throw new Error("isolated DB missing");

    await sendSupportMessage(customer.id, "رسالة أولى", undefined, "account");
    await db.update(supportMessages).set({ createdAt: new Date("2000-01-01T00:00:00Z") }).where(eq(supportMessages.userId, customer.id));
    await replyToSupportMessage(admin.id, customer.id, "account", "رد من الإدارة");
    const [thread] = (await listAdminSupportConversations(admin.id)).filter((item) => item.user.id === customer.id);
    expect(thread.threadStatus).toBe("open");
    expect(new Date(thread.createdAt).getUTCFullYear()).toBe(2000);

    const reference = `TEST-SUPPORT-${suffix}`;
    requestReferences.push(reference);
    await db.insert(requests).values({ reference, userId: customer.id, type: "deposit", amount: "10.00", status: "pending", createdAt: new Date("2001-01-01T00:00:00Z") });
    const queue = await getRecentOperations({ pendingOnly: true, limit: 100 }, admin.id);
    const supportIndex = queue.findIndex((entry) => entry.key === `support-${customer.id}-account`);
    const requestIndex = queue.findIndex((entry) => entry.reference === reference);
    expect(supportIndex).toBeGreaterThanOrEqual(0);
    expect(requestIndex).toBeGreaterThan(supportIndex);

    await closeSupportConversation(admin.id, customer.id, "account");
    const active = await getRecentOperations({ pendingOnly: true, limit: 100 }, admin.id);
    const archive = await getRecentOperations({ historyOnly: true, limit: 100 }, admin.id);
    expect(active.some((entry) => entry.key === `support-${customer.id}-account`)).toBe(false);
    expect(archive.some((entry) => entry.key === `support-${customer.id}-account`)).toBe(true);
  }, 30_000);
});
