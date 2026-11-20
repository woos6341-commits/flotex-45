import { ADMIN_EMAIL } from "../shared/admin";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, notifications, transactions, users, wallets } from "../drizzle/schema";
import { findCustomerByCustomerId, getDb, getUserByOpenId, topUpByCustomerId, upsertUser } from "../server/db";

const openId = `customer-topup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let createdUserId: number | null = null;
let testAdminId: number | null = null;
let createdCustomerId: string | null = null;
let operationId = "";

afterEach(async () => {
  const db = await getDb();
  if (!db || !createdUserId) return;
  await db.delete(transactions).where(eq(transactions.userId, createdUserId));
  await db.delete(notifications).where(eq(notifications.userId, createdUserId));
  if (operationId) await db.delete(auditLogs).where(eq(auditLogs.operationId, operationId));
  await db.delete(wallets).where(eq(wallets.userId, createdUserId));
  await db.delete(users).where(eq(users.id, createdUserId));
  if (testAdminId) await db.delete(users).where(eq(users.id,testAdminId));
  testAdminId=null;
  createdUserId = null;
  createdCustomerId = null;
  operationId = "";
});

describe("customer registration and owner top-up", () => {
  it("generates a unique 10-digit ID, finds the customer, records before/after, and rejects duplicate concurrent top-ups", async () => {
    await upsertUser({ openId, name: "عميل اختبار الشحن", email: `${openId}@example.test`, loginMethod: "test" });
    const user = await getUserByOpenId(openId);
    expect(user).toBeTruthy();
    createdUserId = user!.id;
    createdCustomerId = user!.customerId;
    expect(user!.customerId).toMatch(/^\d{10}$/);

    const found = await findCustomerByCustomerId(createdCustomerId);
    expect(found?.user.id).toBe(createdUserId);
    expect(found?.user.customerId).toBe(createdCustomerId);

    const adminOpenId = `topup-admin-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    await upsertUser({openId:adminOpenId,name:"مسؤول اختبار الشحن",role:"admin",email:ADMIN_EMAIL,loginMethod:"test"});
    testAdminId=(await getUserByOpenId(adminOpenId))!.id;
    operationId = `ATH-TEST-TOPUP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const results = await Promise.allSettled([
      topUpByCustomerId(testAdminId!, createdCustomerId, "125.50", "اختبار شحن موثق", operationId),
      topUpByCustomerId(testAdminId!, createdCustomerId, "125.50", "اختبار شحن موثق", operationId),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);

    const db = await getDb();
    const audit = await db!.select().from(auditLogs).where(and(eq(auditLogs.operationId, operationId), eq(auditLogs.targetUserId, createdUserId))).limit(1);
    expect(audit[0]?.balanceBefore).toBe("0.00");
    expect(audit[0]?.balanceAfter).toBe("125.50");
    const pushMessage = await db!.select().from(notifications).where(and(eq(notifications.userId, createdUserId), eq(notifications.operationId, operationId))).limit(1);
    expect(pushMessage[0]?.title).toBe("تمت إضافة أموال إلى محفظتك");
    expect(pushMessage[0]?.body).toContain("تمت إضافة 125.50 جنيه إلى رصيدك في Flotex EGP.");
    expect(pushMessage).toHaveLength(1);

    await expect(topUpByCustomerId(testAdminId!, createdCustomerId, "0", "شحن صفر", `${operationId}-ZERO`)).rejects.toThrow("أكبر من صفر");
    await expect(topUpByCustomerId(testAdminId!, createdCustomerId, "-1", "شحن سالب", `${operationId}-NEG`)).rejects.toThrow();
  }, 60_000);
});
