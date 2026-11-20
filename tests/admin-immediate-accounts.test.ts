import { describe, expect, it } from "vitest";
import { adminImmediateCreateSchema, adminImmediatePasswordSchema, adminImmediateState } from "../shared/admin-immediate-accounts";
import { createAdminCreatedAccountsRouter } from "../server/admin-created-accounts-router";

const form = { name: "  عميل  اختبار ", email: " Example@EXAMPLE.test ", phoneNumber: "+201012345678", birthDate: "1990-02-20", governorate: "القاهرة" as const, password: "temporary password 123", confirmPassword: "temporary password 123" };

describe("direct admin account boundaries", () => {
  it("requires and normalizes all fields, with no arbitrary role or false verification", () => {
    expect(adminImmediateCreateSchema.parse(form)).toMatchObject({ name: "عميل اختبار", email: "example@example.test", phoneNumber: "01012345678" });
    for (const bad of [
      { ...form, name: "عميل" }, { ...form, phoneNumber: "" }, { ...form, birthDate: "2099-01-01" },
      { ...form, governorate: "غير معروفة" }, { ...form, confirmPassword: "wrong" },
      { ...form, password: "short", confirmPassword: "short" }, { ...form, role: "admin" }, { ...form, emailVerifiedAt: new Date() },
    ]) expect(adminImmediateCreateSchema.safeParse(bad).success).toBe(false);
  });
  it("requires a strong matching password and a valid one-time challenge", () => {
    const challengeToken = "x".repeat(43);
    expect(adminImmediatePasswordSchema.safeParse({ challengeToken, password: "new strong password", confirmPassword: "new strong password" }).success).toBe(true);
    expect(adminImmediatePasswordSchema.safeParse({ challengeToken, password: "new strong password", confirmPassword: "different password" }).success).toBe(false);
    expect(adminImmediatePasswordSchema.safeParse({ challengeToken: "bad", password: "new strong password", confirmPassword: "new strong password" }).success).toBe(false);
  });
  it("derives unused, first-login, and changed states", () => {
    expect(adminImmediateState(null, null)).toBe("unused");
    expect(adminImmediateState(new Date(), null)).toBe("first_login");
    expect(adminImmediateState(new Date(), new Date())).toBe("password_changed");
  });
  it("denies creation and listing to guests", async () => {
    const caller = createAdminCreatedAccountsRouter().createCaller({ user: null, req: {} as any, res: { setHeader() {} } as any });
    await expect(caller.createImmediate(form)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.listImmediate()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
