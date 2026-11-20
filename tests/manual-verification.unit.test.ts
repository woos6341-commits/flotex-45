import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { issueManualVerificationSchema, redeemManualVerificationSchema } from "../shared/manual-verification";
import { hashEmailOtp } from "../server/manual-auth-crypto";

const valid = { email: " USER@EXAMPLE.TEST ", purpose: "register" as const, phoneNumber: "01012345678", validityMinutes: 10, maxAttempts: 5, ownershipConfirmed: true as const, ownershipMethod: "in_person" as const, ownershipCaseRef: "CASE-123" };
describe("manual verification security policy", () => {
  it("requires administrator ownership attestation, a case reference, short TTL and bounded attempts", () => {
    expect(issueManualVerificationSchema.parse(valid).email).toBe("user@example.test");
    for (const invalid of [
      { ...valid, ownershipConfirmed: false }, { ...valid, ownershipCaseRef: "" },
      { ...valid, validityMinutes: 16 }, { ...valid, validityMinutes: 0 },
      { ...valid, maxAttempts: 6 }, { ...valid, maxAttempts: 0 },
      { ...valid, phoneNumber: undefined }, { ...valid, purpose: "password_reset", phoneNumber: valid.phoneNumber },
    ]) expect(issueManualVerificationSchema.safeParse(invalid).success).toBe(false);
  });
  it("does not accept a generic purpose or a code without an identifier and specific email", () => {
    expect(redeemManualVerificationSchema.safeParse({ id: "not-a-uuid", code: "123456", email: "x@example.test", purpose: "register" }).success).toBe(false);
    expect(redeemManualVerificationSchema.safeParse({ code: "123456", purpose: "all" }).success).toBe(false);
  });
  it("uses a keyed, scoped digest and lists no hashes or raw codes", () => {
    const first = hashEmailOtp("local-test-only", "challenge-1", "a@example.test", "register", "123456");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toEqual(hashEmailOtp("local-test-only", "challenge-2", "a@example.test", "register", "123456"));
    expect(first).not.toEqual(hashEmailOtp("local-test-only", "challenge-1", "b@example.test", "register", "123456"));
    expect(first).not.toEqual(hashEmailOtp("local-test-only", "challenge-1", "a@example.test", "password_reset", "123456"));
    const list = readFileSync("server/manual-verification.ts", "utf8").split("export async function listManualVerifications")[1].split("export async function redeemManualVerification")[0];
    expect(list).not.toContain("codeHash:");
  });
});
