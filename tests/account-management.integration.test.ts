import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountStatusEvents,
  pushTokens,
  supportMessages,
  transactions,
  users,
  wallets,
} from "../drizzle/schema";
import {
  authDeviceSessions,
  authEmailChallenges,
  authPasswordCredentials,
  authSupportSessions,
} from "../drizzle/auth-schema";
import { ADMIN_EMAIL } from "../shared/admin";
import { getDb } from "../server/db";
import { applyBalanceAdjustment } from "../server/balance-adjustment";
import { adjustUserCoinBalance } from "../server/coin";
import { hashPassword } from "../server/manual-auth-crypto";
import {
  getOwnAccountDeletionEligibility,
  restoreDeletedCustomerAccount,
  softDeleteOwnAccount,
} from "../server/account-management";
import { listDeletedAccountSupportMessages, sendDeletedAccountSupportMessage } from "../server/account-support";
import {
  changeManualPassword,
  issueEmailCode,
  loginManualAccount,
  verifyEmailCode,
} from "../server/manual-auth";

const mailTestState = vi.hoisted(() => {
  const sentCodes: string[] = [];
  const sendMail = vi.fn(async (message: { text: string }) => {
    const match = message.text.match(/هو: (\d{6})/);
    if (match?.[1]) sentCodes.push(match[1]);
  });
  const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));
  return { sentCodes, createTransport };
});
vi.mock("nodemailer", () => ({ default: { createTransport: mailTestState.createTransport } }));

const customerEmail = `flotex-account-test-${Date.now()}@example.test`;
const customerPassword = "initial-test-password-2026";
let customerId: number | null = null;
let adminId: number | null = null;
let challengeIds: string[] = [];
let transactionIds: number[] = [];

function assertIsIsolatedLocalDatabase() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for local integration tests.");
  const database = new URL(rawUrl);
  if (database.hostname !== "127.0.0.1" || !database.pathname.startsWith("/flotex_test_")) {
    throw new Error("Refusing account integration test: DATABASE_URL must target a loopback-only flotex_test_* database.");
  }
}

beforeAll(() => {
  assertIsIsolatedLocalDatabase();
  process.env.APP_VERIFICATION_SECRET = "test-only-verification-secret-never-use-in-production";
  process.env.AUTH_OTP_APP_PASSWORD = "test-only-not-a-real-mail-password";
  process.env.MANUS_JWT_SECRET = "test-only-session-secret-with-more-than-thirty-two-bytes";
});

async function removeFixtureData() {
  const db = await getDb();
  if (!db) return;
  const ids = [customerId, adminId].filter((id): id is number => id !== null);
  for (const id of ids) {
    await db.delete(supportMessages).where(eq(supportMessages.userId, id));
    await db.delete(authSupportSessions).where(eq(authSupportSessions.userId, id));
    await db.delete(authDeviceSessions).where(eq(authDeviceSessions.userId, id));
    await db.delete(pushTokens).where(eq(pushTokens.userId, id));
    await db.delete(accountStatusEvents).where(eq(accountStatusEvents.targetUserId, id));
    await db.delete(authPasswordCredentials).where(eq(authPasswordCredentials.userId, id));
    await db.delete(wallets).where(eq(wallets.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  if (transactionIds.length) await db.delete(transactions).where(inArray(transactions.id, transactionIds));
  if (challengeIds.length) await db.delete(authEmailChallenges).where(inArray(authEmailChallenges.id, challengeIds));
  customerId = null;
  adminId = null;
  challengeIds = [];
  transactionIds = [];
  mailTestState.sentCodes.length = 0;
}

afterEach(async () => {
  await removeFixtureData();
  mailTestState.createTransport.mockClear();
});

describe("account lifecycle on isolated local MariaDB", () => {
  it("blocks outstanding money, then soft-deletes, limits support, and lets an admin restore the account", async () => {
    assertIsIsolatedLocalDatabase();
    const db = await getDb();
    if (!db) throw new Error("The isolated local MariaDB connection is unavailable.");
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) throw new Error("Refusing integration test because the isolated test database is not empty.");

    const now = new Date();
    await db.insert(users).values([
      {
        openId: `account-test:${Date.now()}`,
        customerId: "1234567890",
        name: "عميل اختبار الحساب",
        email: customerEmail,
        emailNormalized: customerEmail,
        phoneNumber: "01012345678",
        phoneNormalized: "01012345678",
        birthDate: "1990-01-01",
        loginMethod: "password",
        role: "user",
        status: "active",
        deletedAt: null,
        lastSignedIn: now,
      },
      {
        openId: `account-test-admin:${Date.now()}`,
        customerId: "9876543210",
        name: "مدير اختبار محلي",
        email: ADMIN_EMAIL,
        emailNormalized: ADMIN_EMAIL,
        loginMethod: "password",
        role: "admin",
        status: "active",
        deletedAt: null,
        lastSignedIn: now,
      },
    ]);
    const [customer] = await db.select().from(users).where(eq(users.emailNormalized, customerEmail)).limit(1);
    const [admin] = await db.select().from(users).where(eq(users.emailNormalized, ADMIN_EMAIL)).limit(1);
    if (!customer || !admin) throw new Error("Could not create the synthetic local test accounts.");
    customerId = customer.id;
    adminId = admin.id;

    await db.insert(wallets).values({
      userId: customer.id,
      balance: "0.00",
      reservedWithdrawals: "0.00",
      reservedOrders: "0.00",
      reservedTransfers: "0.00",
      reservedSavings: "0.00",
      profitLoss: "0.00",
      currency: "EGP",
    });
    await db.insert(authPasswordCredentials).values({
      userId: customer.id,
      passwordHash: await hashPassword(customerPassword),
      emailVerifiedAt: now,
      phoneVerifiedAt: null,
    });

    const initialEligibility = await getOwnAccountDeletionEligibility(customer.id);
    expect(initialEligibility).toMatchObject({ eligible: true, status: "active" });

    await db.update(wallets).set({ balance: "0.01" }).where(eq(wallets.userId, customer.id));
    expect((await getOwnAccountDeletionEligibility(customer.id)).eligible).toBe(false);
    await db.update(wallets).set({ balance: "0.00" }).where(eq(wallets.userId, customer.id));

    await db.insert(transactions).values({
      userId: customer.id,
      reference: `ACCOUNT-TEST-PENDING-${Date.now()}`,
      type: "adjustment",
      amount: "1.00",
      currency: "EGP",
      status: "pending",
      note: "synthetic pending obligation for isolated test",
      balanceBefore: "0.00",
      balanceAfter: "0.00",
    });
    const pending = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.userId, customer.id), eq(transactions.status, "pending")));
    transactionIds = pending.map((row) => row.id);
    expect((await getOwnAccountDeletionEligibility(customer.id)).eligible).toBe(false);
    await db.delete(transactions).where(inArray(transactions.id, transactionIds));
    transactionIds = [];

    const loggedIn = await loginManualAccount({ email: customerEmail, password: customerPassword, deviceId: "account-test-device-0001" });
    expect(loggedIn.app_session_id).toBeTruthy();
    await db.insert(authDeviceSessions).values({
      userId: customer.id,
      tokenHash: createHash("sha256").update("synthetic-old-session-token").digest("hex"),
      deviceId: "account-test-device-0002",
      deviceName: "جهاز اختبار قديم",
      platform: "android",
      trustedAt: now,
      lastActivityAt: now,
    });
    await db.insert(pushTokens).values({ token: "ExponentPushToken[flotex-account-test]", userId: customer.id, platform: "android" });

    const changed = await changeManualPassword(customer.id, {
      currentPassword: customerPassword,
      password: "updated-test-password-2026",
      confirmPassword: "updated-test-password-2026",
    });
    expect(changed).toEqual({ success: true, mustLoginAgain: true });
    await expect(loginManualAccount({ email: customerEmail, password: customerPassword })).rejects.toThrow();
    const currentPassword = "updated-test-password-2026";
    expect((await loginManualAccount({ email: customerEmail, password: currentPassword })).app_session_id).toBeTruthy();

    await expect(softDeleteOwnAccount(customer.id, {
      customerId: customer.customerId,
      email: "wrong-email@example.test",
      password: currentPassword,
    })).rejects.toThrow(/البريد الإلكتروني/);

    const closed = await softDeleteOwnAccount(customer.id, {
      customerId: customer.customerId,
      email: customerEmail,
      password: currentPassword,
      reason: "طلب اختبار محلي",
    });
    expect(closed.success).toBe(true);
    expect(closed.deletedAt).toBeInstanceOf(Date);
    await expect(loginManualAccount({ email: customerEmail, password: currentPassword })).rejects.toThrow(/تم حذفه/);
    expect(await getOwnAccountDeletionEligibility(customer.id)).toMatchObject({ eligible: false, status: "deleted" });
    await expect(applyBalanceAdjustment(admin.id, customer.id, "1.00", "اختبار محلي", `CLOSED-CASH-${Date.now()}`)).rejects.toThrow(/حساب موقوف/);
    await expect(adjustUserCoinBalance(admin.id, customer.id, "+1", "اختبار محلي", `CLOSED-COIN-${Date.now()}`)).rejects.toThrow(/حساب موقوف/);

    const sessions = await db.select().from(authDeviceSessions).where(eq(authDeviceSessions.userId, customer.id));
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.revokedAt instanceof Date)).toBe(true);
    const [pushToken] = await db.select().from(pushTokens).where(eq(pushTokens.userId, customer.id));
    expect(pushToken?.enabled).toBe(0);

    const supportChallenge = await issueEmailCode({ email: customerEmail, purpose: "account_support", customerId: customer.customerId });
    challengeIds.push(supportChallenge.challengeId);
    expect(mailTestState.sentCodes).toHaveLength(1);
    const verifiedSupport = await verifyEmailCode({ challengeId: supportChallenge.challengeId, code: mailTestState.sentCodes[0]! });
    expect(verifiedSupport.nextStep).toBe("support");
    if (!("supportToken" in verifiedSupport) || !verifiedSupport.supportToken) throw new Error("Support OTP did not create a scoped support token.");
    const supportToken = verifiedSupport.supportToken;
    await sendDeletedAccountSupportMessage(supportToken, "أحتاج استعادة الحساب بعد مراجعة الإدارة.");
    expect(await listDeletedAccountSupportMessages(supportToken)).toMatchObject([
      { senderRole: "user", body: "أحتاج استعادة الحساب بعد مراجعة الإدارة." },
    ]);

    await expect(sendDeletedAccountSupportMessage("invalid-token", "محاولة وصول غير صالحة")).rejects.toThrow(/جلسة الدعم/);
    const restored = await restoreDeletedCustomerAccount(admin.id, customer.id, "تم التحقق من الطلب في الاختبار المحلي");
    expect(restored).toMatchObject({ userId: customer.id, status: "active", unchanged: false });
    const [restoredUser] = await db.select().from(users).where(eq(users.id, customer.id)).limit(1);
    expect(restoredUser).toMatchObject({ status: "active", deletedAt: null });
    await expect(listDeletedAccountSupportMessages(supportToken)).rejects.toThrow(/جلسة الدعم/);
    expect(new Set((await db.select().from(accountStatusEvents).where(eq(accountStatusEvents.targetUserId, customer.id))).map((event) => event.action))).toEqual(new Set(["soft_delete", "restore"]));
    expect((await loginManualAccount({ email: customerEmail, password: currentPassword })).app_session_id).toBeTruthy();
  }, 60_000);
});
