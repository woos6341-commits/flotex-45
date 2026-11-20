import { ADMIN_EMAIL } from "../shared/admin";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";
import { appSettings, auditLogs, moneyTransfers, notifications, pushDeliveries, pushTokens, requests, transactions, users, wallets } from "../drizzle/schema";
import { getDb, getAvailableBalance, createRequest, getOperationLimits } from "../server/db";
import { cancelMoneyTransfer, createMoneyTransfer, listMoneyTransfersForAdmin, listMyMoneyTransfers, lookupTransferRecipient, reviewMoneyTransfer } from "../server/money-transfers";
import { getPaymentLimits } from "../server/payment-settings";
import { formatMoneyMinorUnits, parseMoneyMinorUnits } from "../shared/transactions";
import { appRouter } from "../server/routers";

vi.mock("../server/push", () => ({ sendPushOnce: vi.fn(async () => ({ attempted: 0, sent: 0, configured: false })), registerPushToken: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type TestActor = { id: number; customerId: string; name: string; role: "user" | "admin" };
const testPrefix = `mt-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const fixtureIds: number[] = [];
let actors: { sender: TestActor; recipient: TestActor; admin: TestActor };
let initialUserIds: number[] = [];
let initialWallets: unknown[] = [];
let initialTransactions: unknown[] = [];
let initialTransferMinimumSetting: { value: string; updatedBy: number | null; updatedAt: Date } | null = null;
let senderStartingBalance = 5000;

function operationId() {
  return `ATH-TRANSFER-TEST-${randomUUID()}`;
}

async function uniqueCustomerId() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for isolated transfer integration tests.");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = randomInt(1, 10_000_000_000).toString().padStart(10, "0");
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.customerId, candidate)).limit(1);
    if (!existing) return candidate;
  }
  throw new Error("Could not allocate a unique synthetic customer ID.");
}

async function createActor(role: "user" | "admin", name: string, balance = "0.00"): Promise<TestActor> {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for isolated transfer integration tests.");
  const openId = `${testPrefix}-${role === "admin" ? "a" : "u"}-${randomUUID().slice(0, 12)}`;
  const customerId = await uniqueCustomerId();
  await db.insert(users).values({ openId, customerId, name, role, email: role === "admin" ? ADMIN_EMAIL : null, loginMethod: "isolated-transfer-test" });
  const [user] = await db.select({ id: users.id, customerId: users.customerId }).from(users).where(eq(users.openId, openId)).limit(1);
  if (!user?.customerId) throw new Error("Could not create isolated synthetic user.");
  fixtureIds.push(user.id);
  await db.insert(wallets).values({
    userId: user.id,
    balance,
    reservedWithdrawals: "0.00",
    reservedOrders: "0.00",
    reservedTransfers: "0.00",
    profitLoss: "0.00",
    currency: "EGP",
  });
  return { id: user.id, customerId: user.customerId, name, role };
}

async function cleanupFixtures() {
  const db = await getDb();
  if (!db) return;
  // Never recover/delete fixtures by a global prefix: only IDs created by this run.
  const ids = [...fixtureIds];
  if (!ids.length) return;
  await db.delete(pushDeliveries).where(inArray(pushDeliveries.userId, ids));
  await db.delete(pushTokens).where(inArray(pushTokens.userId, ids));
  await db.delete(notifications).where(inArray(notifications.userId, ids));
  await db.delete(auditLogs).where(inArray(auditLogs.targetUserId, ids));
  await db.delete(transactions).where(inArray(transactions.userId, ids));
  await db.delete(requests).where(inArray(requests.userId, ids));
  await db.delete(moneyTransfers).where(or(inArray(moneyTransfers.senderUserId, ids), inArray(moneyTransfers.recipientUserId, ids)));
  await db.delete(wallets).where(inArray(wallets.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
  fixtureIds.length = 0;
}

async function getTransfer(reference: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable.");
  const [row] = await db.select().from(moneyTransfers).where(eq(moneyTransfers.reference, reference)).limit(1);
  if (!row) throw new Error(`Missing synthetic transfer ${reference}`);
  return row;
}

async function setWallet(userId: number, balance: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable.");
  await db.update(wallets).set({ balance, reservedWithdrawals: "0.00", reservedOrders: "0.00", reservedTransfers: "0.00" }).where(eq(wallets.userId, userId));
}

async function makeTransfer(amount: string, note = "ملاحظة اختبار") {
  return createMoneyTransfer(actors.sender.id, {
    recipientCustomerId: actors.recipient.customerId,
    amount,
    note,
    operationId: operationId(),
  });
}

async function capturePreservedRows() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable.");
  initialUserIds = (await db.select({ id: users.id }).from(users).orderBy(asc(users.id))).map((row) => row.id);
  initialWallets = initialUserIds.length ? await db.select({ userId: wallets.userId, balance: wallets.balance, reservedWithdrawals: wallets.reservedWithdrawals, reservedOrders: wallets.reservedOrders, reservedTransfers: wallets.reservedTransfers, profitLoss: wallets.profitLoss }).from(wallets).where(inArray(wallets.userId, initialUserIds)).orderBy(asc(wallets.userId)) : [];
  initialTransactions = initialUserIds.length ? await db.select({ id: transactions.id, userId: transactions.userId, reference: transactions.reference, amount: transactions.amount, status: transactions.status, balanceBefore: transactions.balanceBefore, balanceAfter: transactions.balanceAfter }).from(transactions).where(inArray(transactions.userId, initialUserIds)).orderBy(asc(transactions.id)) : [];
  const [minimumSetting] = await db.select({ value: appSettings.value, updatedBy: appSettings.updatedBy, updatedAt: appSettings.updatedAt }).from(appSettings).where(eq(appSettings.key, "min_transfer_amount")).limit(1);
  initialTransferMinimumSetting = minimumSetting ?? null;
}

async function expectPreservedRowsUnchanged() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable.");
  const currentUsers = (await db.select({ id: users.id }).from(users).orderBy(asc(users.id))).map((row) => row.id);
  expect(currentUsers).toEqual(initialUserIds);
  const currentWallets = initialUserIds.length ? await db.select({ userId: wallets.userId, balance: wallets.balance, reservedWithdrawals: wallets.reservedWithdrawals, reservedOrders: wallets.reservedOrders, reservedTransfers: wallets.reservedTransfers, profitLoss: wallets.profitLoss }).from(wallets).where(inArray(wallets.userId, initialUserIds)).orderBy(asc(wallets.userId)) : [];
  expect(currentWallets).toEqual(initialWallets);
  const currentTransactions = initialUserIds.length ? await db.select({ id: transactions.id, userId: transactions.userId, reference: transactions.reference, amount: transactions.amount, status: transactions.status, balanceBefore: transactions.balanceBefore, balanceAfter: transactions.balanceAfter }).from(transactions).where(inArray(transactions.userId, initialUserIds)).orderBy(asc(transactions.id)) : [];
  expect(currentTransactions).toEqual(initialTransactions);
  const [currentMinimumSetting] = await db.select({ value: appSettings.value, updatedBy: appSettings.updatedBy, updatedAt: appSettings.updatedAt }).from(appSettings).where(eq(appSettings.key, "min_transfer_amount")).limit(1);
  expect(currentMinimumSetting ?? null).toEqual(initialTransferMinimumSetting);
  const leftoverTransfers = await db.select({ id: moneyTransfers.id }).from(moneyTransfers).where(like(moneyTransfers.idempotencyKey, "ATH-TRANSFER-TEST-%"));
  expect(leftoverTransfers).toHaveLength(0);
  const leftoverTestNotifications = await db.select({ id: notifications.id }).from(notifications)
    .leftJoin(users, eq(notifications.userId, users.id))
    .where(and(like(notifications.operationId, "ATH-TRF-%"), or(isNull(users.id), eq(users.loginMethod, "isolated-transfer-test"))));
  expect(leftoverTestNotifications).toHaveLength(0);
  const leftovers = await db.select({ id: users.id }).from(users).where(like(users.openId, `${testPrefix}%`));
  expect(leftovers).toHaveLength(0);
}

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for transfer integration tests.");
  await capturePreservedRows();
});
beforeEach(async () => {
  senderStartingBalance = Number((await getPaymentLimits()).minTransferAmount) + 5000;
  actors = {
    sender: await createActor("user", "مرسل اختبار آمن", senderStartingBalance.toFixed(2)),
    recipient: await createActor("user", "مستلم اختبار آمن", "25.00"),
    admin: await createActor("admin", "مدير اختبار آمن"),
  };
});
afterEach(async () => cleanupFixtures());
afterAll(async () => {
  await cleanupFixtures();
  await expectPreservedRowsUnchanged();
});

describe("تحويل الأموال بين حسابات اختبار اصطناعية معزولة", () => {
  it("يستخدم حد 1200 الافتراضي عند عدم وجود إعداد محفوظ، ويرفض المبلغ الأقل دون حجز", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    const [savedMinimum] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "min_transfer_amount")).limit(1);
    const limits = await getPaymentLimits();
    if (!savedMinimum) expect(limits.minTransferAmount).toBe(1200);
    const tooSmall = formatMoneyMinorUnits(parseMoneyMinorUnits(String(limits.minTransferAmount)) - 1);
    await expect(makeTransfer(tooSmall)).rejects.toThrow("الحد الأدنى");
    const sender = await getAvailableBalance(actors.sender.id);
    expect(sender.balance).toBe(senderStartingBalance.toFixed(2));
    expect(sender.reservedTransfers).toBe("0.00");
    expect(await lookupTransferRecipient(actors.sender.id, actors.recipient.customerId)).toEqual({ name: actors.recipient.name, isVerified: false });
    expect(await lookupTransferRecipient(actors.sender.id, await uniqueCustomerId())).toBeNull();
    await expect(lookupTransferRecipient(actors.sender.id, actors.sender.customerId)).rejects.toThrow("حسابك نفسه");
  });

  it("ينشئ طلبًا قيد المراجعة ويحجز المبلغ، ويمنع تكرار نفس العملية ويكشف الاسم فقط للمرسل", async () => {
    const limits = await getPaymentLimits();
    const amount = Number(limits.minTransferAmount).toFixed(2);
    const operation = operationId();
    const input = { recipientCustomerId: actors.recipient.customerId, amount, note: "اختبار خاص", operationId: operation };
    const created = await createMoneyTransfer(actors.sender.id, input);
    expect(created).toMatchObject({ status: "pending", duplicate: false });
    const duplicate = await createMoneyTransfer(actors.sender.id, input);
    expect(duplicate).toMatchObject({ reference: created.reference, status: "pending", duplicate: true });
    const sender = await getAvailableBalance(actors.sender.id);
    expect(sender.balance).toBe(senderStartingBalance.toFixed(2));
    expect(sender.reservedTransfers).toBe(created.totalDebit);
    expect(Number(sender.available)).toBe(senderStartingBalance - Number(created.totalDebit));
    expect((await getAvailableBalance(actors.recipient.id)).balance).toBe("25.00");
    const detail = (await listMyMoneyTransfers(actors.sender.id))[0];
    expect(detail).toMatchObject({ reference: created.reference, status: "pending", recipient: { name: actors.recipient.name, isVerified: false } });
    expect(detail).not.toHaveProperty("recipientUserId");
    expect(detail).not.toHaveProperty("recipientCustomerId");
    expect(detail).not.toHaveProperty("idempotencyKey");
    expect(detail).not.toHaveProperty("payloadHash");
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    expect(await db.select().from(moneyTransfers).where(eq(moneyTransfers.reference, created.reference))).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.reference, `${created.reference}-S`))).toHaveLength(1);
    await expect(createMoneyTransfer(actors.sender.id, { ...input, amount: (Number(amount) + 1).toFixed(2) })).rejects.toThrow("بيانات تحويل مختلفة");
  });

  it("يرفض المستلم غير الصحيح أو الإرسال للنفس أو تكرار الحجز بما يتجاوز الرصيد", async () => {
    await expect(createMoneyTransfer(actors.sender.id, { recipientCustomerId: "123", amount: "1200.00", operationId: operationId() })).rejects.toThrow("ID صحيح");
    await expect(createMoneyTransfer(actors.sender.id, { recipientCustomerId: actors.sender.customerId, amount: "1200.00", operationId: operationId() })).rejects.toThrow("حسابك نفسه");
    const minimum = Number((await getPaymentLimits()).minTransferAmount).toFixed(2);
    const reserved = await makeTransfer(minimum);
    const tooMuchForRemainingBalance = (senderStartingBalance - Number(minimum) + 0.01).toFixed(2);
    await expect(makeTransfer(tooMuchForRemainingBalance)).rejects.toThrow("الرصيد المتاح غير كافٍ");
    const wallet = await getAvailableBalance(actors.sender.id);
    expect(wallet.reservedTransfers).toBe(reserved.totalDebit);
    expect(Number(wallet.available)).toBe(senderStartingBalance - Number(reserved.totalDebit));
  });

  it("يرفض التاريخ التقويمي غير الصحيح ومدى البحث المعكوس للمدير", async () => {
    const caller = appRouterCaller(actors.admin);
    await expect(caller.admin.moneyTransfers({ fromDate: "2026-02-30" })).rejects.toThrow("أدخل تاريخًا صحيحًا");
    await expect(caller.admin.moneyTransfers({ fromDate: "2026-10-24", toDate: "2026-10-23" })).rejects.toThrow("تاريخ النهاية");
  });

  it("يتيح للمسؤول تغيير الحد الأدنى من مسار الإدارة ويرفض المستخدم العادي", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    const [original] = await db.select().from(appSettings).where(eq(appSettings.key, "min_transfer_amount")).limit(1);
    try {
      const limits = await appRouterCaller(actors.admin).admin.updateLimits({ minTransferAmount: "1300.00" });
      expect(Number(limits.minTransferAmount)).toBe(1300);
      expect(Number((await getPaymentLimits()).minTransferAmount)).toBe(1300);
      await expect(appRouterCaller(actors.sender).admin.updateLimits({ minTransferAmount: "1400.00" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      if (original) {
        await db.update(appSettings).set({ value: original.value, updatedBy: original.updatedBy, updatedAt: original.updatedAt }).where(eq(appSettings.key, "min_transfer_amount"));
      } else {
        await db.delete(appSettings).where(eq(appSettings.key, "min_transfer_amount"));
      }
    }
  });

  it("يعتمد المدير التحويل مرة واحدة، ويخصم من المرسل ويضيف للمستلم ويسجل الطرفين والإشعارين", async () => {
    const amount = Number((await getPaymentLimits()).minTransferAmount).toFixed(2);
    const created = await makeTransfer(amount, "هدية اختبارية");
    const transfer = await getTransfer(created.reference);
    await expect(reviewMoneyTransfer(actors.sender.id, transfer.id, "approved")).rejects.toThrow("هذه العملية متاحة لحساب المدير المعتمد فقط");
    const caller = appRouterCaller(actors.sender);
    await expect(caller.admin.reviewMoneyTransfer({ transferId: transfer.id, action: "approved" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const result = await reviewMoneyTransfer(actors.admin.id, transfer.id, "approved");
    expect(result).toMatchObject({ success: true, status: "approved", reference: created.reference });
    const senderAfter = await getAvailableBalance(actors.sender.id);
    const recipientAfter = await getAvailableBalance(actors.recipient.id);
    expect(senderAfter.balance).toBe((senderStartingBalance - Number(created.totalDebit)).toFixed(2));
    expect(senderAfter.reservedTransfers).toBe("0.00");
    expect(recipientAfter.balance).toBe((25 + Number(amount)).toFixed(2));
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    const entries = await db.select().from(transactions).where(and(inArray(transactions.userId, [actors.sender.id, actors.recipient.id]), eq(transactions.type, "transfer")));
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.userId === actors.sender.id)).toMatchObject({ status: "approved", direction: "debit", balanceAfter: (senderStartingBalance - Number(amount)).toFixed(2) });
    const [feeEntry] = await db.select().from(transactions).where(and(eq(transactions.userId, actors.sender.id), eq(transactions.type, "fee")));
    expect(feeEntry).toMatchObject({ status: "approved", amount: created.feeAmount, balanceAfter: senderAfter.balance });
    expect(entries.find((entry) => entry.userId === actors.recipient.id)).toMatchObject({ status: "approved", direction: "credit", customerTitle: "استلام أموال", balanceAfter: recipientAfter.balance });
    expect(entries.find((entry) => entry.userId === actors.recipient.id)?.note).toContain(actors.sender.name);
    const notices = await db.select().from(notifications).where(inArray(notifications.userId, [actors.sender.id, actors.recipient.id]));
    expect(notices).toHaveLength(3);
    expect(notices.find((item) => item.userId === actors.recipient.id)?.body).toContain(`أُرسل من ${actors.sender.name}`);
    const adminRows = await listMoneyTransfersForAdmin(actors.admin.id, { search: actors.sender.customerId, status: "approved" });
    expect(adminRows.total).toBe(1);
    expect(adminRows.rows).toHaveLength(1);
    expect(adminRows.rows[0]).toMatchObject({ id: transfer.id, reference: created.reference, sender: { name: actors.sender.name, customerId: actors.sender.customerId, isVerified: false }, recipient: { name: actors.recipient.name, customerId: actors.recipient.customerId, isVerified: false } });
    expect(adminRows.rows[0]).not.toHaveProperty("idempotencyKey");
    expect(adminRows.rows[0]).not.toHaveProperty("payloadHash");
    expect(adminRows.rows[0]).not.toHaveProperty("senderUserId");
    await expect(reviewMoneyTransfer(actors.admin.id, transfer.id, "approved")).rejects.toThrow("مسبقًا");
    expect((await getAvailableBalance(actors.recipient.id)).balance).toBe(recipientAfter.balance);
  });

  it("يرفض التحويل بسبب إلزامي ويعيد الحجز مرة واحدة ويظهر السبب في التفاصيل والإشعار", async () => {
    const amount = Number((await getPaymentLimits()).minTransferAmount).toFixed(2);
    const created = await makeTransfer(amount);
    const transfer = await getTransfer(created.reference);
    await expect(reviewMoneyTransfer(actors.admin.id, transfer.id, "rejected")).rejects.toThrow("سبب الرفض إلزامي");
    const rejectionReason = "بيانات التحويل تحتاج إلى مراجعة إضافية";
    await reviewMoneyTransfer(actors.admin.id, transfer.id, "rejected", rejectionReason);
    const saved = await getTransfer(created.reference);
    expect(saved).toMatchObject({ status: "rejected", rejectionReason });
    const sender = await getAvailableBalance(actors.sender.id);
    expect(sender.balance).toBe(senderStartingBalance.toFixed(2));
    expect(sender.reservedTransfers).toBe("0.00");
    expect((await getAvailableBalance(actors.recipient.id)).balance).toBe("25.00");
    const detail = (await listMyMoneyTransfers(actors.sender.id))[0];
    expect(detail?.rejectionReason).toBe(rejectionReason);
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    const [entry] = await db.select().from(transactions).where(eq(transactions.reference, `${created.reference}-S`));
    expect(entry).toMatchObject({ status: "rejected", note: rejectionReason });
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, actors.sender.id), eq(notifications.operationId, `${created.reference}:rejected`)));
    expect(notice?.body).toContain(rejectionReason);
    await expect(reviewMoneyTransfer(actors.admin.id, transfer.id, "rejected", rejectionReason)).rejects.toThrow("مسبقًا");
    expect((await getAvailableBalance(actors.sender.id)).balance).toBe(senderStartingBalance.toFixed(2));
  });

  it("يلغي المرسل الطلب المعلق ويعيد المبلغ المحجوز مرة واحدة فقط", async () => {
    const amount = Number((await getPaymentLimits()).minTransferAmount).toFixed(2);
    const created = await makeTransfer(amount);
    const transfer = await getTransfer(created.reference);
    await cancelMoneyTransfer(actors.sender.id, transfer.id);
    expect((await getTransfer(created.reference)).status).toBe("cancelled");
    expect(await getAvailableBalance(actors.sender.id)).toMatchObject({ balance: senderStartingBalance.toFixed(2), reservedTransfers: "0.00", available: senderStartingBalance.toFixed(2) });
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    const [entry] = await db.select().from(transactions).where(eq(transactions.reference, `${created.reference}-S`));
    expect(entry?.status).toBe("cancelled");
    await expect(cancelMoneyTransfer(actors.sender.id, transfer.id)).rejects.toThrow("مراجعته أو إلغاؤه");
    expect((await getAvailableBalance(actors.sender.id)).balance).toBe(senderStartingBalance.toFixed(2));
  });

  it("يسمح بعملية قبول واحدة فقط عند التزامن ولا يكرر الإضافة", async () => {
    const amount = Number((await getPaymentLimits()).minTransferAmount).toFixed(2);
    const created = await makeTransfer(amount);
    const transfer = await getTransfer(created.reference);
    const outcomes = await Promise.allSettled([
      reviewMoneyTransfer(actors.admin.id, transfer.id, "approved"),
      reviewMoneyTransfer(actors.admin.id, transfer.id, "approved"),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await getAvailableBalance(actors.recipient.id)).balance).toBe((25 + Number(amount)).toFixed(2));
    const db = await getDb();
    if (!db) throw new Error("Database unavailable.");
    expect(await db.select().from(transactions).where(eq(transactions.reference, `${created.reference}-R`))).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.operationId, `transfer:${created.reference}:recipient`))).toHaveLength(1);
  });

  it("يحمي المبلغ المحجوز من محاولة سحب أخرى أثناء المراجعة", async () => {
    const limits = await getOperationLimits();
    const transferMinimum = Number((await getPaymentLimits()).minTransferAmount);
    const withdrawalMinimumMinor = parseMoneyMinorUnits(String(limits.minWithdrawalAmount));
    const maximumMinor = limits.maxWithdrawalAmount === null ? null : parseMoneyMinorUnits(String(limits.maxWithdrawalAmount));
    if (maximumMinor !== null && maximumMinor <= withdrawalMinimumMinor) return;
    const desiredMinor = Math.max(withdrawalMinimumMinor + 1, 10001);
    const withdrawalAmountMinor = maximumMinor === null ? desiredMinor : Math.min(desiredMinor, maximumMinor);
    const withdrawalAmount = formatMoneyMinorUnits(withdrawalAmountMinor);
    const spendableBeforeReserve = withdrawalAmountMinor - 1;
    await setWallet(actors.sender.id, formatMoneyMinorUnits(parseMoneyMinorUnits(transferMinimum.toFixed(2)) + spendableBeforeReserve));
    const reserved = await makeTransfer(transferMinimum.toFixed(2));
    const before = await getAvailableBalance(actors.sender.id);
    expect(before.available).toBe(formatMoneyMinorUnits(spendableBeforeReserve - (parseMoneyMinorUnits(reserved.totalDebit) - parseMoneyMinorUnits(transferMinimum.toFixed(2)))));
    await expect(createRequest(actors.sender.id, "withdrawal", withdrawalAmount, "محاولة اختبار لا يجب قبولها", undefined, undefined, "01012345678", undefined, { paymentMethodId: "vodafone", operationId: operationId() })).rejects.toThrow("غير كافٍ");
    const after = await getAvailableBalance(actors.sender.id);
    expect(after.available).toBe(before.available);
    expect(after.reservedTransfers).toBe(reserved.totalDebit);
  });
});

function appRouterCaller(actor: TestActor) {
  // Exercise the same server-side role guard used by the application router.
  const user = { ...actor, openId: `${testPrefix}-${actor.role}-${actor.id}`, email: actor.role === "admin" ? ADMIN_EMAIL : null, emailNormalized: null, givenName: null, fatherName: null, phoneNumber: null, phoneNormalized: null, profileCompletedAt: new Date(), loginMethod: "test", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return appRouter.createCaller({ req: {} as any, res: { setHeader: vi.fn() } as any, user } as any);
}

describe("حماية بيانات حسابات العملاء الموجودة أثناء اختبارات التحويل", () => {
  it("تنهي الاختبارات مع بقاء محافظ ومعاملات الحسابات السابقة دون أي تغيير", async () => {
    await cleanupFixtures();
    await expectPreservedRowsUnchanged();
  });
});
