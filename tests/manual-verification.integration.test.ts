import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { authDeviceSessions, authEmailChallenges, authPasswordCredentials } from "../drizzle/auth-schema";
import { manualVerificationCodes } from "../drizzle/manual-verification-schema";
import { appSettings, transactions, users, wallets } from "../drizzle/schema";
import { ADMIN_EMAIL } from "../shared/admin";
import { manualRegistrationSchema } from "../shared/registration";
import { getDb } from "../server/db";
import { hashEmailOtp, hashPassword, verifyPassword } from "../server/manual-auth-crypto";
import { issueEmailCode, registerManualAccount, resetManualPassword, verifyEmailCode } from "../server/manual-auth";
import { issueManualVerification, listManualVerifications, redeemManualVerification, revokeManualVerification } from "../server/manual-verification";
import { manualVerificationRouter } from "../server/manual-verification-router";

const mail = vi.hoisted(() => {
  const sent: Array<{ to: string; code: string }> = [];
  const sendMail = vi.fn(async (message: { to: string; text: string }) => {
    if (!message.to.endsWith("@example.test") && message.to !== "dyblhwyty@gmail.com") throw new Error("Unexpected test address");
    const code = message.text.match(/هو: (\d{6})/)?.[1];
    if (!code) throw new Error("Missing synthetic code");
    sent.push({ to: message.to, code });
  });
  return { sent, sendMail, createTransport: vi.fn(() => ({ sendMail, close: vi.fn() })) };
});
// Never open an SMTP transport, even for the designated admin address.
vi.mock("nodemailer", () => ({ default: { createTransport: mail.createTransport } }));
vi.mock("../server/_core/sdk", () => ({ sdk: { createSessionToken: vi.fn(async () => `synthetic-session-${crypto.randomUUID()}`) } }));
vi.mock("../server/account-controls", () => ({ isCustomerAccountFrozen: vi.fn(async () => false) }));

const enabled = process.env.FLOTEX_RUN_LOCAL_DB_TESTS === "1" && process.env.FLOTEX_RUN_MANUAL_OTP_INTEGRATION === "1";
let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
let adminId = 0;
let customerId = 0;
let ready = false;
const email = "customer-otp@example.test";
const base = { purpose: "password_reset" as const, email, validityMinutes: 10, maxAttempts: 5, ownershipConfirmed: true as const, ownershipMethod: "in_person" as const, ownershipCaseRef: "CASE-TEST-123" };
// Exercise the customer flow exactly as designed: email + code only, never an issue/request ID.
const redeem = (issued: { id: string; code: string }, overrides: Record<string, string> = {}) => redeemManualVerification({ email, purpose: "password_reset", code: issued.code, ...overrides });

describe.skipIf(!enabled)("manual verification on an explicitly enabled empty local test database", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/flotex_test_manualotp") throw new Error("Refusing nonlocal or incorrectly named database");
    process.env.APP_VERIFICATION_SECRET = "isolated-manual-otp-test-secret-never-production";
    process.env.AUTH_OTP_APP_PASSWORD = "synthetic-test-password";
    const connection = await getDb();
    if (!connection) throw new Error("Local test database is unavailable");
    db = connection;
    if ((await db.select().from(users).limit(1)).length || (await db.select().from(manualVerificationCodes).limit(1)).length ||
        (await db.select().from(authEmailChallenges).limit(1)).length || (await db.select().from(appSettings).limit(1)).length ||
        (await db.select().from(wallets).limit(1)).length || (await db.select().from(authPasswordCredentials).limit(1)).length ||
        (await db.select().from(authDeviceSessions).limit(1)).length || (await db.select().from(transactions).limit(1)).length) throw new Error("Refusing any non-empty test database");
    ready = true;
  });
  beforeEach(async () => {
    if (!ready) return;
    await db.insert(users).values([{ openId: "otp-test-admin", customerId: "1000000001", name: "مسؤول الاختبار", email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL, role: "admin" }, { openId: "otp-test-customer", customerId: "1000000002", name: "عميل الاختبار", email, emailNormalized: email, role: "user" }]);
    const [admin] = await db.select().from(users).where(eq(users.openId, "otp-test-admin"));
    const [customer] = await db.select().from(users).where(eq(users.openId, "otp-test-customer"));
    adminId = admin.id; customerId = customer.id;
    await db.insert(authPasswordCredentials).values({ userId: customerId, passwordHash: await hashPassword("original-password-123"), emailVerifiedAt: new Date() });
    await db.insert(wallets).values({ userId: customerId, balance: "123.45", reservedWithdrawals: "3.00", reservedOrders: "0.00", reservedTransfers: "0.00", profitLoss: "0.00", currency: "EGP" });
    await db.insert(transactions).values({ userId: customerId, reference: "OTP-PRESERVE-TEST", type: "deposit", amount: "123.45", currency: "EGP", status: "approved", balanceBefore: "0.00", balanceAfter: "123.45" });
  });
  afterEach(async () => {
    if (!ready) return;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, customerId));
    const ledger = await db.select().from(transactions).where(eq(transactions.userId, customerId));
    expect(wallet).toMatchObject({ balance: "123.45", reservedWithdrawals: "3.00" });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reference: "OTP-PRESERVE-TEST", amount: "123.45", balanceBefore: "0.00", balanceAfter: "123.45" });
    await db.delete(authDeviceSessions); await db.delete(authEmailChallenges); await db.delete(manualVerificationCodes);
    await db.delete(authPasswordCredentials); await db.delete(transactions); await db.delete(wallets); await db.delete(users); await db.delete(appSettings);
    mail.sent.length = 0;
    mail.sendMail.mockClear(); mail.createTransport.mockClear();
  });
  afterAll(() => { vi.restoreAllMocks(); });

  it("performs issuance, one-time redemption and real password reset without changing the wallet", async () => {
    const issued = await issueManualVerification(adminId, base);
    expect(issued.code).toMatch(/^\d{6}$/);
    const [stored] = await db.select().from(manualVerificationCodes).where(eq(manualVerificationCodes.id, issued.id));
    expect(stored.codeHash).toMatch(/^[a-f0-9]{64}$/); expect(stored.codeHash).not.toBe(issued.code);
    const list = await listManualVerifications(adminId);
    expect(list[0]).toMatchObject({ issuedByName: "مسؤول الاختبار", ownershipCaseRef: "CASE-TEST-123", status: "active" });
    expect(JSON.stringify(list)).not.toContain(issued.code); expect(list[0]).not.toHaveProperty("codeHash");
    const grant = await redeem(issued);
    expect(grant.nextStep).toBe("reset");
    await expect(redeem(issued)).rejects.toThrow();
    const session = await resetManualPassword({ challengeId: issued.id, grantToken: grant.grantToken!, password: "replacement-password-123", confirmPassword: "replacement-password-123" });
    expect(session.user.id).toBe(customerId); expect(session.user.role).toBe("user");
    const [credential] = await db.select().from(authPasswordCredentials).where(eq(authPasswordCredentials.userId, customerId));
    expect(await verifyPassword("replacement-password-123", credential.passwordHash)).toBe(true);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, customerId));
    expect(wallet).toMatchObject({ balance: "123.45", reservedWithdrawals: "3.00" });
    await expect(resetManualPassword({ challengeId: issued.id, grantToken: grant.grantToken!, password: "another-password-123", confirmPassword: "another-password-123" })).rejects.toThrow();
    expect((await listManualVerifications(adminId))[0]).toMatchObject({ status: "used", usedAt: expect.any(Date) });
  });

  it("binds both email and purpose and persists attempt lockout", async () => {
    const issued = await issueManualVerification(adminId, { ...base, maxAttempts: 2 });
    await expect(redeem(issued, { email: "other@example.test" })).rejects.toThrow();
    await expect(redeem(issued, { purpose: "register" })).rejects.toThrow();
    const wrongCode = String((Number(issued.code) + 1) % 1_000_000).padStart(6, "0");
    await expect(redeem({ ...issued, code: wrongCode })).rejects.toThrow();
    await expect(redeem({ ...issued, code: wrongCode })).rejects.toThrow();
    await expect(redeem(issued)).rejects.toThrow();
    expect((await listManualVerifications(adminId))[0]).toMatchObject({ status: "locked", attemptCount: 2 });
  });

  it("honors expiration, cancellation and replacement including an already redeemed unspent grant", async () => {
    const expired = await issueManualVerification(adminId, base);
    await db.update(manualVerificationCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(manualVerificationCodes.id, expired.id));
    await expect(redeem(expired)).rejects.toThrow();
    expect((await listManualVerifications(adminId)).find((x: any) => x.id === expired.id)?.status).toBe("expired");
    const old = await issueManualVerification(adminId, base);
    const oldGrant = await redeem(old);
    const replacement = await issueManualVerification(adminId, base);
    await expect(resetManualPassword({ challengeId: old.id, grantToken: oldGrant.grantToken!, password: "replacement-password-123", confirmPassword: "replacement-password-123" })).rejects.toThrow();
    const oldHistory = (await listManualVerifications(adminId)).find((x: any) => x.id === old.id)!;
    expect(oldHistory).toMatchObject({ status: "revoked", revokeReason: "replacement", revokedByName: "مسؤول الاختبار", usedAt: expect.any(Date) });
    await revokeManualVerification(adminId, { id: replacement.id });
    await expect(redeem(replacement)).rejects.toThrow();
    expect((await listManualVerifications(adminId)).find((x: any) => x.id === replacement.id)).toMatchObject({ status: "revoked", revokeReason: "admin", revokedByName: "مسؤول الاختبار" });
  });

  it("invalidates a previous ordinary email challenge for the same email and purpose", async () => {
    const id = randomUUID();
    const code = "451732";
    await db.insert(authEmailChallenges).values({ id, email, purpose: "password_reset", userId: customerId,
      codeHash: hashEmailOtp(process.env.APP_VERIFICATION_SECRET!, id, email, "password_reset", code), codeExpiresAt: new Date(Date.now() + 600_000) });
    await issueManualVerification(adminId, base);
    await expect(verifyEmailCode({ challengeId: id, code })).rejects.toThrow();
    const [challenge] = await db.select().from(authEmailChallenges).where(eq(authEmailChallenges.id, id));
    expect(challenge.codeConsumedAt).toBeInstanceOf(Date);
  });

  it("replaces an unredeemed manual code with a normal code using a normalized scope", async () => {
    const old = await issueManualVerification(adminId, base);
    const replacement = await issueEmailCode({ email: `  ${email.toUpperCase()}  `, purpose: "password_reset" });
    await expect(redeem(old)).rejects.toThrow();
    const [audit] = await db.select().from(manualVerificationCodes).where(eq(manualVerificationCodes.id, old.id));
    expect(audit).toMatchObject({ revokedAt: expect.any(Date), revokedBy: null, revokeReason: "replacement" });
    const verified = await verifyEmailCode({ challengeId: replacement.challengeId, code: mail.sent[0].code });
    expect(verified.nextStep).toBe("reset");
  });

  it("invalidates an already redeemed manual grant when a normal code replaces it", async () => {
    const old = await issueManualVerification(adminId, base);
    const grant = await redeem(old);
    const replacement = await issueEmailCode({ email, purpose: "password_reset" });
    await expect(resetManualPassword({ challengeId: old.id, grantToken: grant.grantToken!, password: "replacement-password-123", confirmPassword: "replacement-password-123" })).rejects.toThrow();
    const [credential] = await db.select().from(authPasswordCredentials).where(eq(authPasswordCredentials.userId, customerId));
    expect(await verifyPassword("original-password-123", credential.passwordHash)).toBe(true);
    expect((await verifyEmailCode({ challengeId: replacement.challengeId, code: mail.sent[0].code })).nextStep).toBe("reset");
  });

  it("invalidates an unspent manual registration grant when ordinary registration is issued", async () => {
    const registrationEmail = "registration-replacement@example.test";
    const phoneNumber = "01012345678";
    const old = await issueManualVerification(adminId, { ...base, email: registrationEmail, purpose: "register", phoneNumber });
    const grant = await redeem(old, { email: registrationEmail, purpose: "register" });
    const replacement = await issueEmailCode({ email: registrationEmail, purpose: "register", phoneNumber });
    const form = manualRegistrationSchema.parse({ fullName: "عميل جديد", email: registrationEmail, phoneNumber, birthDate: "1990-01-01", password: "registration-password-123", confirmPassword: "registration-password-123" });
    await expect(registerManualAccount(form, old.id, grant.grantToken!)).rejects.toThrow();
    expect((await verifyEmailCode({ challengeId: replacement.challengeId, code: mail.sent[0].code })).nextStep).toBe("register");
  });

  it("normal issuance replaces an older normal code and its unspent grant", async () => {
    const first = await issueEmailCode({ email, purpose: "password_reset" });
    const grant = await verifyEmailCode({ challengeId: first.challengeId, code: mail.sent[0].code });
    const second = await issueEmailCode({ email, purpose: "password_reset" });
    await expect(resetManualPassword({ challengeId: first.challengeId, grantToken: grant.grantToken!, password: "replacement-password-123", confirmPassword: "replacement-password-123" })).rejects.toThrow();
    const third = await issueEmailCode({ email, purpose: "password_reset" });
    await expect(verifyEmailCode({ challengeId: second.challengeId, code: mail.sent[1].code })).rejects.toThrow();
    expect((await verifyEmailCode({ challengeId: third.challengeId, code: mail.sent[2].code })).nextStep).toBe("reset");
  });

  it("isolates other email and purpose scopes", async () => {
    const otherEmail = "other-otp@example.test";
    const other = await issueManualVerification(adminId, { ...base, email: otherEmail, purpose: "register", phoneNumber: "01012345678" });
    const support = await issueEmailCode({ email, purpose: "guest_support" });
    const prior = await issueManualVerification(adminId, base);
    await issueEmailCode({ email, purpose: "password_reset" });
    await expect(redeem(prior)).rejects.toThrow();
    const [supportRow] = await db.select().from(authEmailChallenges).where(eq(authEmailChallenges.id, support.challengeId));
    expect(supportRow.codeConsumedAt).toBeNull();
    expect((await redeem(other, { email: otherEmail, purpose: "register" })).nextStep).toBe("register");
  });

  it("rolls back replacement and releases the rate reservation if fake delivery fails", async () => {
    const old = await issueManualVerification(adminId, base);
    const id = randomUUID();
    const code = "451732";
    await db.insert(authEmailChallenges).values({ id, email, purpose: "password_reset", userId: customerId,
      codeHash: hashEmailOtp(process.env.APP_VERIFICATION_SECRET!, id, email, "password_reset", code), codeExpiresAt: new Date(Date.now() + 600_000) });
    mail.sendMail.mockRejectedValueOnce(new Error("simulated transport failure"));
    await expect(issueEmailCode({ email, purpose: "password_reset" })).rejects.toThrow();
    const [audit] = await db.select().from(manualVerificationCodes).where(eq(manualVerificationCodes.id, old.id));
    const [challenge] = await db.select().from(authEmailChallenges).where(eq(authEmailChallenges.id, id));
    expect(audit.revokedAt).toBeNull(); expect(challenge.codeConsumedAt).toBeNull(); expect(challenge.grantConsumedAt).toBeNull();
    expect((await db.select().from(authEmailChallenges))).toHaveLength(1);
    expect((await redeem(old)).nextStep).toBe("reset");
    expect((await verifyEmailCode({ challengeId: id, code })).nextStep).toBe("reset");
    for (let i = 0; i < 3; i++) await issueEmailCode({ email, purpose: "password_reset" });
  });

  it("serializes ordinary delivery and a concurrent manual replacement", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    mail.sendMail.mockImplementationOnce(async (message: { to: string; text: string }) => {
      entered();
      await gate;
      mail.sent.push({ to: message.to, code: message.text.match(/هو: (\d{6})/)![1] });
    });
    const ordinaryPromise = issueEmailCode({ email, purpose: "password_reset" });
    await started;
    const manualPromise = issueManualVerification(adminId, base);
    try {
      expect(await Promise.race([manualPromise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150))])).toBe(false);
    } finally { release(); }
    const [ordinary, manual] = await Promise.all([ordinaryPromise, manualPromise]);
    await expect(verifyEmailCode({ challengeId: ordinary.challengeId, code: mail.sent[0].code })).rejects.toThrow();
    expect((await redeem(manual)).nextStep).toBe("reset");
  }, 30_000);

  it("serializes manual redemption against ordinary issuance and never leaves a usable old grant", async () => {
    const old = await issueManualVerification(adminId, base);
    const [redemption, ordinary] = await Promise.allSettled([redeem(old), issueEmailCode({ email, purpose: "password_reset" })]);
    expect(ordinary.status).toBe("fulfilled");
    if (redemption.status === "fulfilled") {
      await expect(resetManualPassword({ challengeId: old.id, grantToken: redemption.value.grantToken!, password: "replacement-password-123", confirmPassword: "replacement-password-123" })).rejects.toThrow();
    }
    await expect(redeem(old)).rejects.toThrow();
    const [audit] = await db.select().from(manualVerificationCodes).where(eq(manualVerificationCodes.id, old.id));
    expect(audit.revokedAt).toBeInstanceOf(Date);
  }, 30_000);

  it("leaves exactly one usable issue after mixed concurrent issuances", async () => {
    const results = await Promise.all([
      issueManualVerification(adminId, base), issueEmailCode({ email, purpose: "password_reset" }),
      issueManualVerification(adminId, base), issueEmailCode({ email, purpose: "password_reset" }),
    ]);
    expect(results).toHaveLength(4);
    const normal = await db.select().from(authEmailChallenges).where(eq(authEmailChallenges.email, email));
    const manual = await db.select().from(manualVerificationCodes).where(eq(manualVerificationCodes.email, email));
    expect(normal.filter(row => !row.codeConsumedAt).length + manual.filter(row => !row.revokedAt).length).toBe(1);
  }, 30_000);

  it("keeps ordinary admin recovery working while manual admin issuance remains forbidden", async () => {
    await db.insert(authPasswordCredentials).values({ userId: adminId, passwordHash: await hashPassword("original-admin-password"), emailVerifiedAt: new Date() });
    await expect(issueManualVerification(adminId, { ...base, email: ADMIN_EMAIL })).rejects.toThrow();
    const issued = await issueEmailCode({ email: ADMIN_EMAIL, purpose: "password_reset" });
    const grant = await verifyEmailCode({ challengeId: issued.challengeId, code: mail.sent[0].code });
    const session = await resetManualPassword({ challengeId: issued.challengeId, grantToken: grant.grantToken!, password: "new-admin-password-123", confirmPassword: "new-admin-password-123" });
    expect(session.user).toMatchObject({ id: adminId, role: "admin", email: ADMIN_EMAIL });
  });

  it("rechecks the role after redemption, before a password reset can be applied", async () => {
    const issued = await issueManualVerification(adminId, base);
    const grant = await redeem(issued);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, customerId));
    await expect(resetManualPassword({ challengeId: issued.id, grantToken: grant.grantToken!, password: "replacement-password-123", confirmPassword: "replacement-password-123" })).rejects.toThrow();
    const [credential] = await db.select().from(authPasswordCredentials).where(eq(authPasswordCredentials.userId, customerId));
    expect(await verifyPassword("original-password-123", credential.passwordHash)).toBe(true);
  });

  it("registers only the verified email and phone, with ordinary user role and one-time grant", async () => {
    const registrationEmail = "new-otp@example.test";
    const issued = await issueManualVerification(adminId, { ...base, email: registrationEmail, purpose: "register", phoneNumber: "01012345678" });
    const grant = await redeem(issued, { email: registrationEmail, purpose: "register" });
    const form = manualRegistrationSchema.parse({ fullName: "عميل جديد", email: registrationEmail, phoneNumber: "01012345678", birthDate: "1990-01-01", password: "registration-password-123", confirmPassword: "registration-password-123" });
    await expect(registerManualAccount({ ...form, phoneNumber: "01012345679" }, issued.id, grant.grantToken!)).rejects.toThrow();
    await expect(registerManualAccount({ ...form, email: "other@example.test" }, issued.id, grant.grantToken!)).rejects.toThrow();
    const session = await registerManualAccount(form, issued.id, grant.grantToken!);
    expect(session.user).toMatchObject({ email: registrationEmail, role: "user" });
    await expect(registerManualAccount(form, issued.id, grant.grantToken!)).rejects.toThrow();
  });

  it("denies non-admin callers, administrative targets and unconfirmed proof", async () => {
    const [customer] = await db.select().from(users).where(eq(users.id, customerId));
    await expect(issueManualVerification(customerId, base)).rejects.toThrow();
    const caller = manualVerificationRouter.createCaller({ user: customer, res: { setHeader: vi.fn() } } as any);
    await expect(caller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(issueManualVerification(adminId, { ...base, ownershipConfirmed: false })).rejects.toThrow();
    await expect(issueManualVerification(adminId, { ...base, email: ADMIN_EMAIL })).rejects.toThrow();
    await db.update(users).set({ role: "admin" }).where(eq(users.id, customerId));
    await expect(issueManualVerification(adminId, base)).rejects.toThrow();
  });

  it("permits only one concurrent redemption and invalidates earlier concurrent issues", async () => {
    const issued = await issueManualVerification(adminId, base);
    const results = await Promise.allSettled([redeem(issued), redeem(issued)]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const replacements = await Promise.all([issueManualVerification(adminId, base), issueManualVerification(adminId, base)]);
    const rows = (await listManualVerifications(adminId)).filter((x: any) => replacements.some(y => y.id === x.id));
    expect(rows.filter((x: any) => x.status === "active")).toHaveLength(1);
    expect(rows.filter((x: any) => x.status === "revoked")).toHaveLength(1);
  });
});
