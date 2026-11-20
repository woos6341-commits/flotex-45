import { ADMIN_EMAIL } from "../shared/admin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { users, wallets, requests, transactions, auditLogs, notifications } from "../drizzle/schema";

const fixture = vi.hoisted(() => ({ minDeposit:500, minWithdrawal:50, minTransfer:1200 }));
vi.mock("../server/payment-settings", async importOriginal => {
  const actual = await importOriginal<typeof import("../server/payment-settings")>();
  return {...actual,getFeePolicy:async()=>{ const {DEFAULT_FEE_POLICY}=await import("../shared/fee-policy"); return {...DEFAULT_FEE_POLICY,withdrawalTiers:DEFAULT_FEE_POLICY.withdrawalTiers.map((tier,index)=>index===0?{...tier,minimumAmount:String(fixture.minWithdrawal)}:tier)}; },getPaymentMethods:async()=>[
    {id:"vodafone",name:"Vodafone Cash",transferNumber:"fixture-vodafone",imageUrl:null},
    {id:"orange",name:"Orange Cash",transferNumber:"fixture-orange",imageUrl:null},
    {id:"etisalat",name:"Etisalat Cash",transferNumber:"fixture-etisalat",imageUrl:null},
    {id:"instapay",name:"Instapay",transferNumber:null,imageUrl:null},
  ],getPaymentLimits:async()=>({minDepositAmount:fixture.minDeposit,minWithdrawalAmount:fixture.minWithdrawal,minTransferAmount:fixture.minTransfer,maxDepositAmount:null,maxWithdrawalAmount:null,maxTradeAmount:null})};
});
vi.mock("../server/payment-media",async importOriginal=>{
  const actual=await importOriginal<typeof import("../server/payment-media")>();
  return {...actual,saveReceipt:vi.fn(async(userId:number)=>`/manus-storage/private-receipts/${userId}/fixture.enc`),readReceipt:vi.fn(async()=>({dataUrl:"fixture-authorized-receipt"}))};
});
vi.mock("../server/push",()=>({sendPushOnce:vi.fn(async()=>({sent:0})),registerPushToken:vi.fn()}));
import { createRequest, ensureWallet, getAvailableBalance, getDb, getRequestReceipt, getCustomerRequests, getUserByOpenId, reviewRequest, upsertUser } from "../server/db";
import { appRouter, paymentRequestSchema } from "../server/routers";
import { saveReceipt } from "../server/payment-media";

const PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=";
let customer=0, admin=0, other=0;
const ids:number[]=[];
const op=()=>`ATH-TEST-${randomUUID()}`;
vi.setConfig({testTimeout:120000,hookTimeout:120000});
async function createFixtures(){
  for(const [role, name] of [["user","عميل اختبار خاص"],["admin","مسؤول اختبار خاص"],["user","عميل اختبار آخر"]] as const){
    const openId=`payments-test-${randomUUID()}`;
    await upsertUser({openId,name,role,email:role === "admin" ? ADMIN_EMAIL : undefined,loginMethod:"test"});
    const user=await getUserByOpenId(openId);if(!user)throw Error("fixture creation failed");ids.push(user.id);
    await ensureWallet(user.id);
  }
  [customer,admin,other]=ids;
}
async function cleanupFixtures(){
  const db=await getDb();if(!db||!ids.length)return;
  for (const table of [requests,transactions,notifications,wallets])await db.delete(table).where(inArray(table.userId,ids));
  await db.delete(auditLogs).where(inArray(auditLogs.targetUserId,ids));
  await db.delete(users).where(inArray(users.id,ids));
}
async function wallet(balance:string){const db=await getDb();await db!.update(wallets).set({balance,reservedWithdrawals:"0.00",reservedOrders:"0.00",reservedTransfers:"0.00"}).where(eq(wallets.userId,customer));}
async function item(reference:string){const db=await getDb();return (await db!.select().from(requests).where(eq(requests.reference,reference)))[0];}
const deposit=(amount="500.00",operationId=op(),sender="01000000000",receipt=PNG)=>createRequest(customer,"deposit",amount,undefined,undefined,undefined,undefined,receipt,{paymentMethodId:"vodafone",operationId,senderReference:sender});
const withdraw=(amount="50.00",operationId=op())=>createRequest(customer,"withdrawal",amount,"ملاحظة اختبار",undefined,undefined,"01000000000",undefined,{paymentMethodId:"orange",operationId});

function hasLocalTestDatabase() {
  if (process.env.FLOTEX_RUN_LOCAL_DB_TESTS !== "1" || !process.env.DATABASE_URL) return false;
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1"].includes(host) && /^\/flotex_test_[a-zA-Z0-9_]+$/.test(parsed.pathname);
  } catch { return false; }
}
const localDbTests = hasLocalTestDatabase();
describe.runIf(localDbTests)("manual payment requests against real DB using isolated fixtures",()=>{
  beforeAll(createFixtures);
  afterAll(cleanupFixtures);
  it("rejects deposit below500, missing receipt, forged image and missing sender before any save",async()=>{
    const count=vi.mocked(saveReceipt).mock.calls.length;
    await expect(deposit("499.99")).rejects.toThrow("500.00");
    await expect(deposit("500.00",op(),"01000000000","")).rejects.toThrow("صورة");
    await expect(deposit("500.00",op(),"01000000000","data:image/png;base64,ZmFrZQ==")).rejects.toThrow("محتوى");
    await expect(deposit("500.00",op(),"")).rejects.toThrow("رقم المرسل");
    expect(vi.mocked(saveReceipt).mock.calls.length).toBe(count);
  });
  it("rejects unconfigured transfer method and unknown method",async()=>{
    await expect(createRequest(customer,"deposit","500.00",undefined,undefined,undefined,undefined,PNG,{paymentMethodId:"instapay",operationId:op(),senderReference:"12345"})).rejects.toThrow("رقم تحويل");
    await expect(createRequest(customer,"deposit","500.00",undefined,undefined,undefined,undefined,PNG,{paymentMethodId:"invented",operationId:op(),senderReference:"12345"})).rejects.toThrow("وسيلة الدفع غير متاحة");
  });
  it("creates a pending deposit without balance change, deduplicates concurrency and rejects changed payload",async()=>{
    await wallet("0.00");const operationId=op();
    const [a,b]=await Promise.all([deposit("500.00",operationId),deposit("500.00",operationId)]);
    expect(a).toBe(b);const saved=await item(a);expect(saved.status).toBe("pending");expect(saved.transferNumberSnapshot).toBe("fixture-vodafone");expect(saved.paymentMethodId).toBe("vodafone");expect((await getAvailableBalance(customer)).balance).toBe("0.00");
    await expect(deposit("501.00",operationId)).rejects.toThrow("بيانات مختلفة");
    await reviewRequest(saved.id,admin,"rejected",{rejectionReason:"رفض اصطناعي للاختبار"});
  });
  it("requires true transfer confirmation then credits exactly once with audit and notification",async()=>{
    await wallet("0.00");const reference=await deposit();const saved=await item(reference);
    await expect(reviewRequest(saved.id,admin,"approved")).rejects.toThrow("تأكيد");
    await expect(reviewRequest(saved.id,customer,"approved",{confirmedTransfer:true})).rejects.toThrow("لحساب المدير المعتمد");
    const depositReference=`TEST-INBOUND-${randomUUID()}`;
    const results=await Promise.allSettled([reviewRequest(saved.id,admin,"approved",{confirmedTransfer:true,depositReference}),reviewRequest(saved.id,admin,"approved",{confirmedTransfer:true,depositReference})]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect((await getAvailableBalance(customer)).balance).toBe("500.00");
    const db=await getDb();expect(await db!.select().from(transactions).where(eq(transactions.reference,reference))).toHaveLength(1);
    const [movement]=await db!.select().from(transactions).where(eq(transactions.reference,reference));
    expect(movement).toMatchObject({direction:"credit",customerTitle:"إيداع",customerDescription:"تم قبول الإيداع؛ الإيداع مجاني بلا رسوم.",source:"manual_deposit",balanceBefore:"0.00",balanceAfter:"500.00"});
    const audit=await db!.select().from(auditLogs).where(eq(auditLogs.operationId,`review:${reference}`));expect(audit).toHaveLength(1);expect(audit[0].balanceBefore).toBe("0.00");expect(audit[0].balanceAfter).toBe("500.00");
    const notice=await db!.select().from(notifications).where(and(eq(notifications.userId,customer),eq(notifications.operationId,reference)));expect(notice).toHaveLength(1);expect(notice[0].title).toBe("تم قبول الإيداع");
    const second=await item(await deposit());
    await expect(reviewRequest(second.id,admin,"approved",{confirmedTransfer:true,depositReference})).rejects.toThrow("مستخدم مسبقًا");
    expect((await getAvailableBalance(customer)).balance).toBe("500.00");
  });
  it("rejects withdrawal below50 and insufficiency without reservation",async()=>{
    await wallet("200.00");await expect(withdraw("49.99")).rejects.toThrow("50.00");await expect(withdraw("200.01")).rejects.toThrow("غير كاف");expect((await getAvailableBalance(customer)).reservedWithdrawals).toBe("0.00");
  });
  it("reserves without debiting and releases rejected withdrawals",async()=>{
    await wallet("200.00");const reference=await withdraw("100.00");const available=await getAvailableBalance(customer);expect(available.balance).toBe("200.00");expect(available.available).toBe("95.00");const saved=await item(reference);await reviewRequest(saved.id,admin,"rejected",{rejectionReason:"رفض اصطناعي للاختبار"});expect((await getAvailableBalance(customer)).available).toBe("200.00");expect((await getAvailableBalance(customer)).balance).toBe("200.00");
  });
  it("only completes withdrawal after payout reference and confirmed transfer then debits once",async()=>{
    await wallet("200.00");const reference=await withdraw("100.00");const saved=await item(reference);
    await expect(reviewRequest(saved.id,admin,"approved",{confirmedTransfer:true})).rejects.toThrow("تم التنفيذ");
    await expect(reviewRequest(saved.id,admin,"completed",{confirmedTransfer:true})).rejects.toThrow("مرجع");
    const confirmation={confirmedTransfer:true,payoutReference:`TEST-PAYOUT-${randomUUID()}`};
    const results=await Promise.allSettled([reviewRequest(saved.id,admin,"completed",confirmation),reviewRequest(saved.id,admin,"completed",confirmation)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const available=await getAvailableBalance(customer);expect(available.balance).toBe("95.00");expect(available.reservedWithdrawals).toBe("0.00");expect((await item(reference)).status).toBe("completed");
    const db=await getDb();const [movement]=await db!.select().from(transactions).where(eq(transactions.reference,`${reference}-W`));
    expect(movement).toMatchObject({direction:"debit",customerTitle:"سحب",customerDescription:"تم تنفيذ السحب 100.00 ج.م؛ الرسوم 5.00 ج.م؛ الإجمالي 105.00 ج.م.",source:"withdrawal_request",balanceBefore:"200.00",balanceAfter:"100.00"});
    const [fee]=await db!.select().from(transactions).where(eq(transactions.reference,`${reference}-F`));
    expect(fee).toMatchObject({type:"fee",amount:"5.00",balanceBefore:"100.00",balanceAfter:"95.00"});
  });
  it("concurrent withdrawal requests cannot spend same funds",async()=>{
    await wallet("85.00");const outcomes=await Promise.allSettled([withdraw("80.00"),withdraw("80.00")]);expect(outcomes.filter(o=>o.status==="fulfilled")).toHaveLength(1);expect((await getAvailableBalance(customer)).available).toBe("0.00");const fulfilled=outcomes.find(o=>o.status==="fulfilled") as PromiseFulfilledResult<string>;await reviewRequest((await item(fulfilled.value)).id,admin,"rejected",{rejectionReason:"رفض اصطناعي للاختبار"});
  });
  it("client-provided references are untrusted and cannot reserve confirmed transfer references",async()=>{
    const a=await deposit();const b=await deposit();expect(a).not.toBe(b);
    const ref=`TEST-TRANSFER-${randomUUID()}`;
    const first=await createRequest(customer,"deposit","500.00",undefined,undefined,ref,undefined,PNG,{paymentMethodId:"vodafone",operationId:op()});
    const second=await createRequest(customer,"deposit","500.00",undefined,undefined,ref,undefined,PNG,{paymentMethodId:"vodafone",operationId:op()});
    const saved=await item(first);expect(saved.transferReference).toBeNull();expect(saved.submittedTransferReference).toBe(ref);
    await expect(reviewRequest(saved.id,admin,"approved",{confirmedTransfer:true})).rejects.toThrow("الوارد المؤكد");
    await reviewRequest(saved.id,admin,"approved",{confirmedTransfer:true,depositReference:ref});
    await expect(reviewRequest((await item(second)).id,admin,"approved",{confirmedTransfer:true,depositReference:ref})).rejects.toThrow("مستخدم مسبقًا");
    await expect(createRequest(customer,"withdrawal","50.00",undefined,undefined,ref,"01000000000",undefined,{paymentMethodId:"orange",operationId:op()})).rejects.toThrow("المسؤول بعد التنفيذ");
  });
  it("receipt is readable only by owner or persisted admin; unauthenticated/admin APIs reject clients",async()=>{
    const saved=await item(await deposit());
    const publicRows=await getCustomerRequests(customer);expect(publicRows.find(r=>r.id===saved.id)).not.toHaveProperty("receiptImageUrl");
    await expect(getRequestReceipt(other,saved.id)).rejects.toThrow("غير متاح");
    expect(await getRequestReceipt(customer,saved.id)).toEqual({dataUrl:"fixture-authorized-receipt"});
    expect(await getRequestReceipt(admin,saved.id,true)).toEqual({dataUrl:"fixture-authorized-receipt"});
    const db=await getDb();const [user]=await db!.select().from(users).where(eq(users.id,customer));
    const ctx={req:{} as any,res:{setHeader:vi.fn()} as any,user};
    const caller=appRouter.createCaller(ctx);
    await expect(caller.admin.updateLimits({minDepositAmount:"250.00"})).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(appRouter.createCaller({...ctx,user:null}).payment.methods({direction:"deposit"})).rejects.toMatchObject({code:"UNAUTHORIZED"});
  });
  it("honors lowered administrative limits rather than hardcoding500/50",async()=>{
    fixture.minDeposit=100;fixture.minWithdrawal=10;await wallet("100.00");
    const dep=await deposit("100.00");expect((await item(dep)).amount).toBe("100.00");const wd=await withdraw("10.00");expect((await item(wd)).amount).toBe("10.00");await reviewRequest((await item(wd)).id,admin,"rejected",{rejectionReason:"رفض اصطناعي للاختبار"});fixture.minDeposit=500;fixture.minWithdrawal=50;
  });
});

describe("payment API payload validation",()=>{
  it("requires image and sender reference for deposit and destination for withdrawal",()=>{
    const base={amount:"500.00",operationId:op(),paymentMethodId:"vodafone"};
    expect(paymentRequestSchema.safeParse({...base,type:"deposit"}).success).toBe(false);
    expect(paymentRequestSchema.safeParse({...base,type:"deposit",senderReference:"01000000000",receiptImageData:PNG}).success).toBe(true);
    expect(paymentRequestSchema.safeParse({...base,type:"withdrawal"}).success).toBe(false);
    expect(paymentRequestSchema.safeParse({...base,type:"withdrawal",destination:"01000000000"}).success).toBe(true);
  });
});
