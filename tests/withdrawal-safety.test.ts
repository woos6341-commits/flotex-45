import { ADMIN_EMAIL } from "../shared/admin";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditLogs, notifications, orders, requests, transactions, users, wallets } from "../drizzle/schema";
import { adjustBalance, createRequest, ensureWallet, getAvailableBalance, getDb, getUserByOpenId, INSUFFICIENT_BALANCE_MESSAGE, NEGATIVE_BALANCE_MESSAGE, upsertUser } from "../server/db";

let testUserId:number|undefined;
let testAdminId:number;
beforeAll(async()=>{const openId=`withdrawal-admin-${randomUUID()}`;await upsertUser({openId,name:"مسؤول اختبار السحب",role:"admin",email:ADMIN_EMAIL,loginMethod:"test"});testAdminId=(await getUserByOpenId(openId))!.id;});
afterAll(async()=>{const db=await getDb();if(db&&testAdminId)await db.delete(users).where(eq(users.id,testAdminId));});
vi.setConfig({testTimeout:60000,hookTimeout:60000});
beforeEach(async()=>{
  const openId=`withdrawal-safety-${randomUUID()}`;
  await upsertUser({openId,name:"عميل اختبار قواعد السحب",loginMethod:"test"});
  const user=await getUserByOpenId(openId);testUserId=user!.id;await ensureWallet(testUserId);
});
async function resetFixture(balance:string){const db=await getDb();await db!.update(wallets).set({balance}).where(eq(wallets.userId,testUserId!));}
afterEach(async()=>{
  const db=await getDb();if(!db||!testUserId)return;
  for(const table of [requests,orders,transactions,notifications,wallets])await db.delete(table).where(eq(table.userId,testUserId));
  await db.delete(auditLogs).where(eq(auditLogs.targetUserId,testUserId));
  await db.delete(users).where(eq(users.id,testUserId));testUserId=undefined;
});
function withdraw(amount:string){return createRequest(testUserId!,"withdrawal",amount,undefined,"Vodafone Cash",undefined,"01000000000");}
describe("withdrawal safety",()=>{
  it("rejects a withdrawal when the balance is zero",async()=>{await resetFixture("0.00");await expect(withdraw("50.00")).rejects.toThrow(INSUFFICIENT_BALANCE_MESSAGE);});
  it("rejects a withdrawal greater than available balance",async()=>{await resetFixture("50.00");await expect(withdraw("50.01")).rejects.toThrow(INSUFFICIENT_BALANCE_MESSAGE);});
  it("accepts the available amount and reserves without debiting",async()=>{await resetFixture("55.00");await withdraw("50.00");const available=await getAvailableBalance(testUserId!);expect(available.balance).toBe("55.00");expect(available.reservedWithdrawals).toBe("55.00");expect(available.available).toBe("0.00");});
  it("only one concurrent withdrawal can reserve the same funds",async()=>{await resetFixture("85.00");const results=await Promise.allSettled([withdraw("80.00"),withdraw("80.00")]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);});
  it("rejects an administrative debit that creates a negative balance",async()=>{await resetFixture("20.00");await expect(adjustBalance(testAdminId,testUserId!,"-20.01","اختبار منع الرصيد السالب",`test-${randomUUID()}`)).rejects.toThrow(NEGATIVE_BALANCE_MESSAGE);});
});
