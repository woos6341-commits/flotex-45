import { describe, expect, it } from "vitest";
import {
  constantTimeHexEqual,
  hashEmailOtp,
  hashPassword,
  verifyPassword,
} from "../server/manual-auth-crypto";
import {
  emailAddressSchema,
  manualRegistrationSchema,
  normalizeEmail,
  normalizePhoneNumber,
} from "../shared/registration";

const validRegistration = {
  fullName: "أحمد محمود",
  email: "CUSTOMER@example.com",
  phoneNumber: "٠١٠١٢٣٤٥٦٧٨",
  birthDate: "1990-01-31",
  password: "a-secure-password-123",
  confirmPassword: "a-secure-password-123",
};

describe("manual account input validation", () => {
  it("normalizes email case and Egyptian phone numerals", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
    expect(emailAddressSchema.parse(" USER@Example.COM ")).toBe("user@example.com");
    expect(normalizePhoneNumber("٠١٠١٢٣٤٥٦٧٨")).toBe("01012345678");
  });

  it("accepts a valid manual registration and rejects mismatched passwords", () => {
    expect(manualRegistrationSchema.safeParse(validRegistration).success).toBe(true);
    expect(
      manualRegistrationSchema.safeParse({
        ...validRegistration,
        confirmPassword: "a-different-password",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid email and invalid or too-short phone input", () => {
    expect(manualRegistrationSchema.safeParse({ ...validRegistration, email: "bad" }).success).toBe(false);
    expect(manualRegistrationSchema.safeParse({ ...validRegistration, phoneNumber: "123" }).success).toBe(false);
  });
});

describe("password and one-time-code cryptography", () => {
  it("stores only a salted scrypt hash and verifies the original password", async () => {
    const first = await hashPassword("strong password 123");
    const second = await hashPassword("strong password 123");
    expect(first).not.toBe("strong password 123");
    expect(first).not.toBe(second);
    expect(first.startsWith("scrypt$32768$8$1$")).toBe(true);
    await expect(verifyPassword("strong password 123", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password 123", first)).resolves.toBe(false);
  }, 15_000);

  it("binds OTP digests to a challenge, email, purpose and code", () => {
    const original = hashEmailOtp("test-only-secret", "id-1", "a@example.com", "register", "123456");
    const same = hashEmailOtp("test-only-secret", "id-1", "a@example.com", "register", "123456");
    const changed = hashEmailOtp("test-only-secret", "id-1", "a@example.com", "password_reset", "123456");
    expect(constantTimeHexEqual(original, same)).toBe(true);
    expect(constantTimeHexEqual(original, changed)).toBe(false);
    expect(constantTimeHexEqual("invalid", original)).toBe(false);
  });
});
