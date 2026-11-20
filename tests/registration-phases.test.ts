import { describe, expect, it } from "vitest";
import { completeManualRegistrationSchema, registrationDetailsSchema } from "../shared/registration";

const details = {
  fullName: "أحمد محمد",
  email: "test@example.com",
  phoneNumber: "01012345678",
  birthDate: "1990-01-31",
  governorate: "القاهرة" as const,
};

describe("registration validation phases", () => {
  it("validates the personal-details step without running security-pin validation", () => {
    const result = registrationDetailsSchema.safeParse(details);
    expect(result.success).toBe(true);
  });

  it("does not accept a later-step security pin field in the personal-details contract", () => {
    const result = registrationDetailsSchema.safeParse({ ...details, securityPin: "" });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).not.toBe("رمز الأمان يجب أن يتكون من 4 أرقام");
  });

  it("validates the security pin only in the final registration step", () => {
    const valid = completeManualRegistrationSchema.safeParse({ ...details, password: "safe-password-2026", confirmPassword: "safe-password-2026", securityPin: "1234" });
    const invalid = completeManualRegistrationSchema.safeParse({ ...details, password: "safe-password-2026", confirmPassword: "safe-password-2026", securityPin: "" });
    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
    expect(invalid.success ? "" : invalid.error.issues.some((issue) => issue.message === "رمز الأمان يجب أن يتكون من 4 أرقام")).toBe(true);
  });
});
