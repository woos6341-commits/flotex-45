import { ADMIN_EMAIL } from "../shared/admin";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditLogs, notifications, requests, transactions, users, wallets } from "../drizzle/schema";
import { adjustBalance, customerDetails, ensureWallet, getAvailableBalance, getDb, getPortfolio, getTransactions, getUserByOpenId, NEGATIVE_BALANCE_MESSAGE, topUpByCustomerId, upsertUser } from "../server/db";

vi.mock("../server/push", () => ({ sendPushOnce: vi.fn().mockResolvedValue({ sent: 0 }) }));
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
let adminId: number;
let customerId: number;
let publicId: string;
const operationId = () => `TEST-LEDGER-${randomUUID()}`;

beforeAll(async () => {
  const openId = `ledger-admin-${randomUUID()}`;
  await upsertUser({ openId, name: "مسؤول اختبار سجل المعاملات", role: "admin", email: ADMIN_EMAIL, loginMethod: "test" });
  adminId = (await getUserByOpenId(openId))!.id;
});
beforeEach(async () => {
  const openId = `ledger-customer-${randomUUID()}`;
  await upsertUser({ openId, name: "عميل اختبار سجل المعاملات", loginMethod: "test" });
  const customer = (await getUserByOpenId(openId))!;
  customerId = customer.id; publicId = customer.customerId;
  await ensureWallet(customerId);
});
afterEach(async () => {
  const db = await getDb(); if (!db || !customerId) return;
  for (const table of [requests, transactions, notifications, wallets]) await db.delete(table).where(eq(table.userId, customerId));
  await db.delete(auditLogs).where(eq(auditLogs.targetUserId, customerId));
  await db.delete(users).where(eq(users.id, customerId));
});
afterAll(async () => { const db=await getDb(); if(db&&adminId)await db.delete(users).where(eq(users.id,adminId)); });
async function fund(amount="100.00") { return adjustBalance(adminId,customerId,amount,"تهيئة رصيد حساب الاختبار",operationId()); }
async function rowCounts() {
  const db=await getDb();
  return { tx:(await db!.select({id:transactions.id}).from(transactions).where(eq(transactions.userId,customerId))).length, audit:(await db!.select({id:auditLogs.id}).from(auditLogs).where(eq(auditLogs.targetUserId,customerId))).length, notice:(await db!.select({id:notifications.id}).from(notifications).where(eq(notifications.userId,customerId))).length };
}

describe("committed customer balance and unified ledger", () => {
  it("persists positive and negative administrative movements with exact balance snapshots and correct customer descriptions", async () => {
    const first=await fund("125.50"); const second=await adjustBalance(adminId,customerId,"-25.25","سبب الخصم الخاص بالإدارة",operationId());
    expect(first).toMatchObject({balanceBefore:"0.00",balanceAfter:"125.50",direction:"credit"});
    expect(second).toMatchObject({balanceBefore:"125.50",balanceAfter:"100.25",direction:"debit"});
    expect((await getAvailableBalance(customerId)).balance).toBe("100.25");
    const history=await getTransactions(customerId);
    expect(history[0]).toMatchObject({customerTitle:"خصم",customerDescription:"تم خصم الأموال",direction:"debit",displayAmount:"25.25",signedAmount:"-25.25",balanceBefore:"125.50",balanceAfter:"100.25",source:"admin_adjustment"});
    expect(history[1]).toMatchObject({customerTitle:"إيداع",customerDescription:"تمت إضافة الأموال",direction:"credit",signedAmount:"125.50"});
    expect(history[0].note).toBe("تم خصم الأموال");
    const adminHistory=(await customerDetails(customerId))!.history;
    expect(adminHistory.find(row=>row.reference===second.operationId)!.note).toBe("سبب الخصم الخاص بالإدارة");
    expect((await getPortfolio(customerId))!.activity.find(row=>row.reference===second.operationId)!.signedAmount).toBe("-25.25");
  });
  it("records ID top-up in the same ledger with one audit and one success notice",async()=>{
    const id=operationId(); await topUpByCustomerId(adminId,publicId,"125.50","شحن حساب اختبار",id);
    expect(await rowCounts()).toEqual({tx:1,audit:1,notice:1});
    expect((await getTransactions(customerId))[0]).toMatchObject({reference:id,customerTitle:"إيداع",customerDescription:"تمت إضافة الأموال",balanceAfter:"125.50"});
  });
  it("rejects a debit above available funds including reservations and creates no success records",async()=>{
    await fund(); const db=await getDb();
    await db!.update(wallets).set({reservedWithdrawals:"60.00",reservedOrders:"10.00"}).where(eq(wallets.userId,customerId));
    const before=await rowCounts();
    await expect(adjustBalance(adminId,customerId,"-30.01","اختبار منع خصم المحجوز",operationId())).rejects.toThrow(NEGATIVE_BALANCE_MESSAGE);
    expect((await getAvailableBalance(customerId))).toMatchObject({balance:"100.00",available:"30.00"});
    expect(await rowCounts()).toEqual(before);
    await adjustBalance(adminId,customerId,"-30.00","خصم المتاح فقط",operationId());
    expect((await getAvailableBalance(customerId))).toMatchObject({balance:"70.00",available:"0.00"});
  });
  it("serializes concurrent debits so only one can consume the same balance",async()=>{
    await fund(); const attempts=await Promise.allSettled([adjustBalance(adminId,customerId,"-80.00","خصم متزامن أول",operationId()),adjustBalance(adminId,customerId,"-80.00","خصم متزامن ثان",operationId())]);
    expect(attempts.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect(attempts.filter(item=>item.status==="rejected")).toHaveLength(1);
    expect((await getAvailableBalance(customerId)).balance).toBe("20.00");
    expect(await rowCounts()).toEqual({tx:2,audit:2,notice:2});
  });
  it("cannot duplicate a concurrent administrative movement using the same operation ID",async()=>{
    const id=operationId(); const attempts=await Promise.allSettled([adjustBalance(adminId,customerId,"100.00","إضافة متزامنة",id),adjustBalance(adminId,customerId,"100.00","إضافة متزامنة",id)]);
    expect(attempts.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect((await getAvailableBalance(customerId)).balance).toBe("100.00");
    expect(await rowCounts()).toEqual({tx:1,audit:1,notice:1});
  });
  it("rolls back balance, audit and notification when the transaction row cannot be saved",async()=>{
    await fund(); const db=await getDb(); const id=operationId();
    await db!.insert(transactions).values({userId:customerId,reference:id,type:"adjustment",amount:"0.00",status:"pending",note:"سجل اختبار تعارض الحفظ"});
    const before=await rowCounts();
    await expect(adjustBalance(adminId,customerId,"50.00","اختبار فشل حفظ السجل",id)).rejects.toThrow();
    expect((await getAvailableBalance(customerId)).balance).toBe("100.00");
    expect(await rowCounts()).toEqual(before);
    expect((await getTransactions(customerId)).find(row=>row.reference===id)!.customerDescription).toBe("العملية قيد المراجعة");
  });
  it("rejects invalid inputs and non-admin calls without changing the ledger",async()=>{
    for(const amount of ["0","-0.00","1.001","NaN","Infinity","1e2"])await expect(adjustBalance(adminId,customerId,amount,"اختبار قيمة غير صالحة",operationId())).rejects.toThrow();
    await expect(adjustBalance(customerId,customerId,"100.00","طلب عميل غير مصرح",operationId())).rejects.toThrow("هذه العملية متاحة لحساب المدير المعتمد فقط");
    expect(await rowCounts()).toEqual({tx:0,audit:0,notice:0});
    expect((await getAvailableBalance(customerId)).balance).toBe("0.00");
  });
});
