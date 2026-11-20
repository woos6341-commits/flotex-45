import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { accountVerifications, authPasswordCredentials, notifications, phoneChangeRequests, phoneVerificationRequests, userProfileAudits, users, wallets } from "../drizzle/schema";
import { authDeviceSessions, authLoginChallenges } from "../drizzle/auth-schema";
import { getDb } from "../server/db";
import { hashPassword } from "../server/manual-auth-crypto";
import { encryptNationalId } from "../server/profile-data";
import { submitAccountVerification, getAdminAccountVerificationDocuments } from "../server/account-verification";
import { submitPhoneChangeRequest, reviewPhoneChangeRequest, getMyPhoneChangeRequest } from "../server/phone-change";
import { fingerprintAccountVerificationValue } from "../server/account-verification-crypto";
import { loginManualAccount } from "../server/manual-auth";
import { isPresentedSessionRevoked } from "../server/session-management";
import { ADMIN_EMAIL } from "../shared/admin";

const ownedIds: number[] = [];
const prefix = `phone-kyc-test-${randomUUID()}`;
function syntheticNationalId() {
  const first = "2900101011234";
  const weights = [2, 7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const checksum = (11 - weights.reduce((sum, weight, i) => sum + Number(first[i]) * weight, 0) % 11) % 10;
  return first + checksum;
}
// Signature-valid synthetic bytes, NOT an actual identity document or a person's photo.
const image = { mimeType: "image/jpeg" as const, data: Buffer.from([255, 216, 255, ...new Array(32).fill(1)]).toString("base64") };
const documents = { idFront: image, idBack: image, selfie: image, walletProfile: image };
async function fixture(role: "user" | "admin", phone: string) {
  const db = (await getDb())!;
  const openId = `${prefix}-${role}`;
  const email = role === "admin" ? ADMIN_EMAIL : `${prefix}@example.test`;
  await db.insert(users).values({ openId, customerId: role === "admin" ? "9880000001" : "9880000002", name: "حساب اصطناعي لاختبار التوثيق", email, emailNormalized: email, role, givenName: "اصطناعي", fatherName: "اختبار", phoneNumber: phone, phoneNormalized: phone, birthDate: "1990-01-01", governorate: "القاهرة", profileCompletedAt: new Date(), loginMethod: "password", nationalIdCiphertext: encryptNationalId(syntheticNationalId()), nationalIdLast4: syntheticNationalId().slice(-4) });
  const [user] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  ownedIds.push(user.id);
  await db.insert(wallets).values({ userId: user.id, balance: "230.00", currency: "EGP" });
  await db.insert(authPasswordCredentials).values({ userId: user.id, passwordHash: await hashPassword("SyntheticPhoneTest2026!"), emailVerifiedAt: new Date() });
  return user;
}

afterEach(async () => {
  if (!ownedIds.length) return;
  const db = (await getDb())!;
  const ids = [...ownedIds];
  await db.delete(authDeviceSessions).where(inArray(authDeviceSessions.userId, ids));
  await db.delete(authLoginChallenges).where(inArray(authLoginChallenges.userId, ids));
  await db.delete(phoneChangeRequests).where(inArray(phoneChangeRequests.userId, ids));
  await db.delete(phoneVerificationRequests).where(inArray(phoneVerificationRequests.userId, ids));
  await db.delete(accountVerifications).where(inArray(accountVerifications.userId, ids));
  await db.delete(userProfileAudits).where(inArray(userProfileAudits.targetUserId, ids));
  await db.delete(notifications).where(inArray(notifications.userId, ids));
  await db.delete(authPasswordCredentials).where(inArray(authPasswordCredentials.userId, ids));
  await db.delete(wallets).where(inArray(wallets.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
  ownedIds.length = 0;
});

describe("KYC and phone change on explicitly isolated empty database", () => {
  it("encrypts documents, rejects repeat submission, approves phone atomically, preserves balance and keeps session valid", async () => {
    if (process.env.FLOTEX_ISOLATED_TEST_DB !== "1") throw new Error("Set FLOTEX_ISOLATED_TEST_DB=1 only for a confirmed independent empty test database.");
    const db = await getDb();
    if (!db) throw new Error("Independent test DB missing");
    if ((await db.select({ id: users.id }).from(users)).length) throw new Error("Refusing KYC integration: test database is not empty.");
    const admin = await fixture("admin", "01098800001");
    const user = await fixture("user", "01098800002");
    const session = await loginManualAccount({ email: user.email!, password: "SyntheticPhoneTest2026!", deviceId: prefix });
    if (!session.app_session_id) throw new Error("Expected real authenticated synthetic session");
    const token = session.app_session_id;
    expect(await isPresentedSessionRevoked(user.id, token)).toBe(false);
    await expect(submitAccountVerification(user.id, { birthDate: "1990-01-01", ...documents })).resolves.toMatchObject({ status: "pending" });
    const [stored] = await db.select().from(accountVerifications).where(eq(accountVerifications.userId, user.id));
    expect(stored.idFrontCiphertext).not.toEqual(image.data);
    const shown = await getAdminAccountVerificationDocuments(admin.id, user.id);
    expect(shown.documents.idFront).toBe(`data:image/jpeg;base64,${image.data}`);
    await expect(submitAccountVerification(user.id, { birthDate: "1990-01-01", ...documents })).rejects.toThrow("قيد المراجعة");
    const phone = "01098800003";
    const request = await submitPhoneChangeRequest(user.id, { newPhoneNumber: phone, ...documents });
    expect((await getMyPhoneChangeRequest(user.id)).currentPhoneNumber).toBe(user.phoneNumber);
    await expect(submitPhoneChangeRequest(user.id, { newPhoneNumber: phone, ...documents })).rejects.toThrow("قيد المراجعة");
    await db.insert(phoneVerificationRequests).values({ userId: user.id, phoneNumber: user.phoneNumber!, phoneNormalized: user.phoneNormalized!, status: "pending", message: "synthetic old-phone request" });
    await expect(reviewPhoneChangeRequest(admin.id, request.id, "approve")).resolves.toMatchObject({ status: "approved", phoneNumber: phone });
    const after = await getMyPhoneChangeRequest(user.id);
    expect(after.currentPhoneNumber).toBe(phone);
    const [kycAfter] = await db.select().from(accountVerifications).where(eq(accountVerifications.userId, user.id));
    expect(kycAfter.phoneFingerprint).toBe(fingerprintAccountVerificationValue("phone", phone));
    const [oldRequest] = await db.select().from(phoneVerificationRequests).where(eq(phoneVerificationRequests.userId, user.id));
    expect(oldRequest.status).toBe("cancelled");
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, user.id));
    expect(wallet.balance).toBe("230.00");
    expect(await isPresentedSessionRevoked(user.id, token)).toBe(false);
    const notices = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notices).toHaveLength(1);
    await expect(reviewPhoneChangeRequest(admin.id, request.id, "approve")).rejects.toThrow("تمت مراجعته");
    await expect(submitPhoneChangeRequest(user.id, { newPhoneNumber: phone, ...documents })).rejects.toThrow("مطابق");
    const rejected = await submitPhoneChangeRequest(user.id, { newPhoneNumber: "01098800004", ...documents });
    await reviewPhoneChangeRequest(admin.id, rejected.id, "reject", "صور اختبار غير كافية");
    expect((await getMyPhoneChangeRequest(user.id)).currentPhoneNumber).toBe(phone);
    expect((await db.select().from(notifications).where(eq(notifications.userId, user.id))).length).toBe(2);
    const retry = await submitPhoneChangeRequest(user.id, { newPhoneNumber: "01098800004", ...documents });
    await expect(reviewPhoneChangeRequest(admin.id, retry.id, "reject", "أعد تصوير المستند بصورة أوضح")).resolves.toMatchObject({ status: "rejected" });
    expect((await getMyPhoneChangeRequest(user.id)).currentPhoneNumber).toBe(phone);
    expect((await db.select().from(notifications).where(eq(notifications.userId, user.id))).length).toBe(3);
  }, 60_000);
});
