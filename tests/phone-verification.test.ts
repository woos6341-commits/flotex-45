import { describe, expect, it } from "vitest";
import { formatLocalDateOnly } from "../shared/date-only";
import {
  adminCustomerProfileSchema,
  buildPhoneVerificationEmailUrl,
  buildPhoneVerificationTelegramUrl,
  canUserEditPhone,
  isPhoneVerified,
  phoneRequestMatchesCurrentNumber,
  phoneVerificationContactsSchema,
  phoneVerificationReviewSchema,
} from "../shared/phone-verification";

describe("سياسة توثيق الهاتف", () => {
  it("يسمح بتعديل الرقم قبل التوثيق فقط ويطابق الطلب مع الرقم الحالي", () => {
    expect(canUserEditPhone(null)).toBe(true);
    expect(canUserEditPhone(undefined)).toBe(true);
    expect(canUserEditPhone(new Date())).toBe(false);
    expect(isPhoneVerified("2026-10-28T00:00:00Z")).toBe(true);
    expect(phoneRequestMatchesCurrentNumber({ phoneNormalized: "01012345678" }, "+20 1012345678")).toBe(true);
    expect(phoneRequestMatchesCurrentNumber({ phoneNormalized: "01012345678" }, "01112345678")).toBe(false);
  });

  it("يقبل قنوات رسمية فارغة أو بريدًا صحيحًا وTelegram قابلًا للتحقق", () => {
    expect(phoneVerificationContactsSchema.parse({ email: "", telegramUsername: "" })).toEqual({ email: "", telegramUsername: "" });
    expect(phoneVerificationContactsSchema.parse({ email: "Verify@Flotex.example", telegramUsername: "@flotex_verify" })).toEqual({ email: "verify@flotex.example", telegramUsername: "flotex_verify" });
    expect(buildPhoneVerificationTelegramUrl("https://t.me/flotex_verify")).toBe("https://t.me/flotex_verify");
    expect(buildPhoneVerificationEmailUrl("verify@flotex.example", { customerId: "0012345678", name: "أحمد علي", phoneNumber: "01012345678" })).toContain("mailto:verify@flotex.example?");
    expect(buildPhoneVerificationEmailUrl("bad-address", {})).toBeNull();
  });

  it("يرفض رابط Telegram غير الرسمي والبريد غير الصحيح", () => {
    expect(phoneVerificationContactsSchema.safeParse({ email: "bad", telegramUsername: "https://evil.example/user" }).success).toBe(false);
    expect(buildPhoneVerificationTelegramUrl("https://evil.example/user")).toBeNull();
  });

  it("يفرض تأكيد ملكية الرقم قبل الموافقة وسببًا عند الرفض", () => {
    expect(phoneVerificationReviewSchema.safeParse({ requestId: 1, status: "approved", ownershipConfirmed: false }).success).toBe(false);
    expect(phoneVerificationReviewSchema.safeParse({ requestId: 1, status: "approved", ownershipConfirmed: true }).success).toBe(true);
    expect(phoneVerificationReviewSchema.safeParse({ requestId: 1, status: "rejected", note: "لا" }).success).toBe(false);
    expect(phoneVerificationReviewSchema.safeParse({ requestId: 1, status: "rejected", note: "رقم غير مطابق" }).success).toBe(true);
  });

  it("يسمح بتعديل بيانات الملف المطلوبة فقط ويرفض حقول المال والصلاحيات", () => {
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, phoneNumber: "01012345678" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, givenName: "أحمد", fatherName: "علي", phoneNumber: "01012345678" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, givenName: "أحمد" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, fullName: "أحمد علي حسن" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, email: "new@example.com" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, birthDate: "1990-01-01" }).success).toBe(true);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, birthDate: formatLocalDateOnly(tomorrow) }).success).toBe(false);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, governorate: "القاهرة" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, governorate: "محافظة غير موجودة" }).success).toBe(false);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, nationalId: "12345678901234" }).success).toBe(true);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, nationalId: "1234567890123" }).success).toBe(false);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, role: "admin", phoneNumber: "01012345678" }).success).toBe(false);
    expect(adminCustomerProfileSchema.safeParse({ userId: 5, balance: "999999", phoneNumber: "01012345678" }).success).toBe(false);
  });
});
