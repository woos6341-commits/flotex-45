import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { authDeviceSessions, authEmailChallenges, authPasswordCredentials } from "../drizzle/auth-schema";
import { appSettings, transactions, users, wallets } from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  issueEmailCode,
  ManualAuthError,
  changeManualPasswordWithEmailCode,
  loginManualAccount,
  registerManualAccount,
  resetManualPassword,
  verifyEmailCode,
} from "../server/manual-auth";
import { manualRegistrationSchema } from "../shared/registration";

const fixtureEmail = `flotex-auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
const fixturePhone = `010${Math.floor(Math.random() * 100_000_000).toString().padStart(8, "0")}`;
const mailTestState = vi.hoisted(() => {
  const sentCodes: string[] = [];
  const sendMail = vi.fn(async (message: { text: string }) => {
    const match = message.text.match(/هو: (\d{6})/);
    if (match?.[1]) sentCodes.push(match[1]);
  });
  const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));
  return { sentCodes, sendMail, createTransport };
});
const sentCodes = mailTestState.sentCodes;
const fakeMailer = { createTransport: mailTestState.createTransport };
vi.mock("nodemailer", () => ({ default: { createTransport: mailTestState.createTransport } }));
process.env.APP_VERIFICATION_SECRET ??= "test-only-verification-hmac-secret";
process.env.AUTH_OTP_APP_PASSWORD ??= "test-only-not-a-real-mail-password";
process.env.MANUS_JWT_SECRET ??= "test-only-manus-session-signing-secret-at-least-32-bytes";

let createdUserId: number | null = null;
let legacyUserId: number | null = null;
let challengeIds: string[] = [];

function assertIsolatedTestDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw || process.env.FLOTEX_RUN_LOCAL_DB_TESTS !== "1") {
    throw new Error("Refusing integration test: an explicitly enabled local test database is required.");
  }
  const url = new URL(raw);
  if (url.hostname !== "127.0.0.1" || !/^\/flotex_test_[a-zA-Z0-9_]+$/.test(url.pathname)) {
    throw new Error("Refusing integration test outside a loopback flotex_test_* database.");
  }
}

async function removeFixtureData() {
  assertIsolatedTestDatabase();
  const db = await getDb();
  if (!db) return;
  for (const userId of [createdUserId, legacyUserId]) {
    if (userId === null) continue;
    await db.delete(authDeviceSessions).where(eq(authDeviceSessions.userId, userId));
    await db.delete(authPasswordCredentials).where(eq(authPasswordCredentials.userId, userId));
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(wallets).where(eq(wallets.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  createdUserId = null;
  legacyUserId = null;
  for (const id of challengeIds) await db.delete(authEmailChallenges).where(eq(authEmailChallenges.id, id));
  await db.delete(appSettings).where(like(appSettings.key, "otp_rl:%"));
  challengeIds = [];
  sentCodes.length = 0;
}

afterEach(async () => {
  await removeFixtureData();
  fakeMailer.createTransport.mockClear();
});

describe("manual auth integration on the isolated Flotex database", () => {
  beforeAll(assertIsolatedTestDatabase);

  it("atomically limits concurrent OTP requests to three per email in the rolling window", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is not configured; run against the empty Flotex test database only.");
    const initialUsers = await db.select({ id: users.id }).from(users);
    if (initialUsers.length !== 0) throw new Error("Refusing rate-limit integration test because the connected Flotex database is not empty.");

    const email = `flotex-rate-limit-${randomUUID()}@example.test`;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      issueEmailCode({ email, purpose: "guest_support" }),
    ));
    const accepted = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof issueEmailCode>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    challengeIds.push(...accepted.map((result) => result.value.challengeId));

    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((result) => result.reason instanceof ManualAuthError && result.reason.code === "TOO_MANY_REQUESTS")).toBe(true);
    expect(mailTestState.createTransport).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("releases OTP rate-limit reservations after a synthetic mail delivery failure", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is not configured; run against the empty Flotex test database only.");
    const initialUsers = await db.select({ id: users.id }).from(users);
    if (initialUsers.length !== 0) throw new Error("Refusing mail-failure integration test because the connected Flotex database is not empty.");

    const email = `flotex-mail-retry-${randomUUID()}@example.test`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      mailTestState.sendMail.mockRejectedValueOnce(new Error("synthetic SMTP failure"));
      await expect(issueEmailCode({ email, purpose: "guest_support" })).rejects.toThrow("تعذر إرسال رمز التحقق");
    }

    const retry = await issueEmailCode({ email, purpose: "guest_support" });
    challengeIds.push(retry.challengeId);
    expect(sentCodes).toHaveLength(1);
    expect(mailTestState.createTransport).toHaveBeenCalledTimes(4);
  }, 60_000);

  it("registers once, rejects duplicate email/phone, logs in, and resets via verified email without creating another customer", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is not configured; run against the empty Flotex test database only.");
    const initialUsers = await db.select({ id: users.id }).from(users);
    if (initialUsers.length !== 0) throw new Error("Refusing integration test because the connected Flotex database is not empty.");

    const legacyEmail = `legacy-${fixtureEmail}`;
    const legacyPhone = "01098765432";
    const legacyCustomerId = "8765432109";
    const legacyOpenId = `legacy-manual-test-${randomUUID()}`;
    const legacyReference = `LEGACY-TEST-${randomUUID()}`;
    await db.insert(users).values({
      openId: legacyOpenId,
      customerId: legacyCustomerId,
      name: "عميل قديم للاختبار",
      email: legacyEmail,
      phoneNumber: legacyPhone,
      loginMethod: "google",
      role: "user",
    });
    const [legacyUser] = await db.select().from(users).where(eq(users.openId, legacyOpenId)).limit(1);
    if (!legacyUser) throw new Error("Could not create synthetic legacy account for the preservation test.");
    legacyUserId = legacyUser.id;
    await db.insert(wallets).values({
      userId: legacyUser.id,
      balance: "300.00",
      reservedWithdrawals: "25.00",
      reservedOrders: "10.00",
      profitLoss: "15.00",
      currency: "EGP",
    });
    await db.insert(transactions).values({
      userId: legacyUser.id,
      reference: legacyReference,
      type: "deposit",
      amount: "300.00",
      currency: "EGP",
      status: "approved",
      note: "synthetic preservation fixture",
      balanceBefore: "0.00",
      balanceAfter: "300.00",
    });

    process.env.MANUS_JWT_SECRET ??= `flotex-test-${Date.now()}-session-signing-secret-material`;
    const registration = manualRegistrationSchema.parse({
      fullName: "عميل اختبار فلو تك",
      email: fixtureEmail,
      phoneNumber: fixturePhone,
      birthDate: "1990-01-31",
      password: "test-password-2026-safe",
      confirmPassword: "test-password-2026-safe",
    });

    const registerChallenge = await issueEmailCode({ email: fixtureEmail, purpose: "register", phoneNumber: fixturePhone });
    challengeIds.push(registerChallenge.challengeId);
    expect(sentCodes).toHaveLength(1);
    const verified = await verifyEmailCode({ challengeId: registerChallenge.challengeId, code: sentCodes[0]! });
    expect(verified.nextStep).toBe("register");
    if (!verified.grantToken) throw new Error("OTP did not produce a registration grant.");

    const session = await registerManualAccount(registration, registerChallenge.challengeId, verified.grantToken);
    createdUserId = session.user.id;
    expect(session.user.customerId).toMatch(/^\d{10}$/);
    expect(session.user.role).toBe("user");

    const [credential] = await db.select().from(authPasswordCredentials).where(eq(authPasswordCredentials.userId, createdUserId));
    expect(credential?.passwordHash).toMatch(/^scrypt\$32768\$/);
    expect(credential?.passwordHash).not.toContain(registration.password);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, createdUserId));
    expect(wallet?.balance).toBe("0.00");
    const [consumedRegistrationChallenge] = await db.select().from(authEmailChallenges).where(eq(authEmailChallenges.id, registerChallenge.challengeId));
    expect(consumedRegistrationChallenge?.codeHash).toMatch(/^[\da-f]{64}$/);
    expect(consumedRegistrationChallenge?.codeHash).not.toBe(sentCodes[0]);

    await expect(issueEmailCode({ email: fixtureEmail, purpose: "register", phoneNumber: fixturePhone })).rejects.toThrow(/حساب قائم|مستخدم بالفعل/);
    await expect(issueEmailCode({ email: `different-${fixtureEmail}`, purpose: "register", phoneNumber: fixturePhone })).rejects.toThrow(/رقم الهاتف مستخدم بالفعل/);

    const loggedIn = await loginManualAccount({ email: fixtureEmail, password: registration.password });
    expect(loggedIn.user.id).toBe(createdUserId);
    expect(loggedIn.user.customerId).toBe(session.user.customerId);
    expect(loggedIn.app_session_id).toBeTruthy();
    await expect(loginManualAccount({ email: fixtureEmail, password: "wrong-password-123" })).rejects.toThrow();

    const resetChallenge = await issueEmailCode({ email: fixtureEmail, purpose: "password_reset" });
    challengeIds.push(resetChallenge.challengeId);
    const resetCode = sentCodes.at(-1)!;
    const resetVerified = await verifyEmailCode({ challengeId: resetChallenge.challengeId, code: resetCode });
    if (!resetVerified.grantToken) throw new Error("OTP did not produce a reset grant.");
    const resetSession = await resetManualPassword({ challengeId: resetChallenge.challengeId, grantToken: resetVerified.grantToken, password: "new-test-password-2026", confirmPassword: "new-test-password-2026" });
    expect(resetSession.user.id).toBe(createdUserId);
    expect(resetSession.user.customerId).toBe(session.user.customerId);
    await expect(loginManualAccount({ email: fixtureEmail, password: registration.password })).rejects.toThrow();
    const finalLogin = await loginManualAccount({ email: fixtureEmail, password: "new-test-password-2026" });
    expect(finalLogin.user.id).toBe(createdUserId);

    const changeChallenge = await issueEmailCode({ email: fixtureEmail, purpose: "password_reset" });
    challengeIds.push(changeChallenge.challengeId);
    const changeCode = sentCodes.at(-1)!;
    const wrongChangeCode = changeCode === "000000" ? "000001" : "000000";
    await expect(changeManualPasswordWithEmailCode(createdUserId!, {
      challengeId: changeChallenge.challengeId,
      code: wrongChangeCode,
      currentPassword: "new-test-password-2026",
      password: "changed-test-password-2026",
      confirmPassword: "changed-test-password-2026",
    })).rejects.toThrow("رمز التحقق غير صحيح");
    await expect(changeManualPasswordWithEmailCode(createdUserId!, {
      challengeId: changeChallenge.challengeId,
      code: changeCode,
      currentPassword: "new-test-password-2026",
      password: "changed-test-password-2026",
      confirmPassword: "changed-test-password-2026",
    })).resolves.toMatchObject({ success: true, mustLoginAgain: true });
    const [consumedChangeChallenge] = await db.select().from(authEmailChallenges).where(eq(authEmailChallenges.id, changeChallenge.challengeId));
    expect(consumedChangeChallenge?.codeConsumedAt).toBeInstanceOf(Date);
    const userSessions = await db.select().from(authDeviceSessions).where(eq(authDeviceSessions.userId, createdUserId!));
    expect(userSessions.length).toBeGreaterThan(0);
    expect(userSessions.every((item) => item.revokedAt instanceof Date)).toBe(true);
    await expect(loginManualAccount({ email: fixtureEmail, password: "new-test-password-2026" })).rejects.toThrow();
    expect((await loginManualAccount({ email: fixtureEmail, password: "changed-test-password-2026" })).user.id).toBe(createdUserId);

    const legacyResetChallenge = await issueEmailCode({ email: legacyEmail, purpose: "password_reset" });
    challengeIds.push(legacyResetChallenge.challengeId);
    const legacyVerified = await verifyEmailCode({ challengeId: legacyResetChallenge.challengeId, code: sentCodes.at(-1)! });
    if (!legacyVerified.grantToken) throw new Error("OTP did not produce a legacy-account reset grant.");
    const restoredLegacy = await resetManualPassword({ challengeId: legacyResetChallenge.challengeId, grantToken: legacyVerified.grantToken, password: "legacy-new-password-2026", confirmPassword: "legacy-new-password-2026" });
    expect(restoredLegacy.user.id).toBe(legacyUser.id);
    expect(restoredLegacy.user.customerId).toBe(legacyCustomerId);
    const legacyLogin = await loginManualAccount({ email: legacyEmail, password: "legacy-new-password-2026" });
    expect(legacyLogin.user.id).toBe(legacyUser.id);
    expect(legacyLogin.user.customerId).toBe(legacyCustomerId);
    const [legacyWalletAfterReset] = await db.select().from(wallets).where(eq(wallets.userId, legacyUser.id));
    expect(legacyWalletAfterReset).toMatchObject({ balance: "300.00", reservedWithdrawals: "25.00", reservedOrders: "10.00", profitLoss: "15.00" });
    const legacyTransactionsAfterReset = await db.select().from(transactions).where(eq(transactions.userId, legacyUser.id));
    expect(legacyTransactionsAfterReset).toHaveLength(1);
    expect(legacyTransactionsAfterReset[0]).toMatchObject({ reference: legacyReference, balanceBefore: "0.00", balanceAfter: "300.00" });

    const finalUsers = await db.select({ id: users.id }).from(users);
    expect(finalUsers.map((user) => user.id).sort()).toEqual([createdUserId, legacyUserId].sort());
    const finalWallets = await db.select().from(wallets).where(eq(wallets.userId, createdUserId));
    expect(finalWallets).toHaveLength(1);
    expect(finalWallets[0]?.balance).toBe("0.00");
  }, 60_000);
});
