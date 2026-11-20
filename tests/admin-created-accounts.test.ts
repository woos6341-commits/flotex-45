import { describe, expect, it } from "vitest";
import { adminCreatedAccountCreateSchema, adminCreatedClaimSchema, adminCreatedIdentitySchema } from "../shared/admin-created-accounts";
import { createAdminCreatedAccountsRouter } from "../server/admin-created-accounts-router";

describe("admin account input boundaries", () => {
  it("normalizes an email and accepts only basic information", () => {
    expect(adminCreatedAccountCreateSchema.parse({ name: "  عميل  تجريبي ", email: "  Client@EXAMPLE.test  " })).toEqual({ name: "عميل تجريبي", email: "client@example.test" });
    expect(adminCreatedAccountCreateSchema.safeParse({ name: "عميل تجريبي", email: "a@example.test", password: "admin-chosen-password", role: "admin" }).success).toBe(false);
    expect(adminCreatedAccountCreateSchema.safeParse({ name: "عميل تجريبي", email: "a@example.test", emailVerifiedAt: new Date() }).success).toBe(false);
  });
  it("permits only a case reference and requires matching, sufficiently long owner password", () => {
    expect(adminCreatedIdentitySchema.safeParse({ id: "59da8412-13c0-4ce0-8654-80c200347293", evidenceRef: "CASE-1234" }).success).toBe(true);
    expect(adminCreatedIdentitySchema.safeParse({ id: "59da8412-13c0-4ce0-8654-80c200347293", evidenceRef: "image data/private ID" }).success).toBe(false);
    expect(adminCreatedIdentitySchema.safeParse({ id: "59da8412-13c0-4ce0-8654-80c200347293", evidenceRef: "12345678901234" }).success).toBe(false);
    const token = "a".repeat(43);
    expect(adminCreatedClaimSchema.safeParse({ token, password: "short", confirmPassword: "short" }).success).toBe(false);
    expect(adminCreatedClaimSchema.safeParse({ token, password: "long enough password", confirmPassword: "another password" }).success).toBe(false);
  });
  it("keeps public activation disabled until guards and delivery have been explicitly installed", async () => {
    const caller = createAdminCreatedAccountsRouter().createCaller({ user: null, req: {} as any, res: { setHeader() {} } as any });
    await expect(caller.claim({ token: "a".repeat(43), password: "strong test password", confirmPassword: "strong test password" })).rejects.toThrow(/غير مهيأ/);
    await expect(caller.create({ name: "عميل تجريبي", email: "someone@example.test" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
