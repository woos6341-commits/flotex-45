import { describe, expect, it } from "vitest";
import { ACCOUNT_VERIFICATION_ACTION_LABEL, ACCOUNT_VERIFICATION_REQUIRED_MESSAGE, ACCOUNT_VERIFICATION_ROUTE, getMoneyRequestAccessState, getMoneyRequestVerificationPrompt, isMoneyRequestAllowedByVerification } from "../shared/account-verification-policy";

describe("account verification money-request policy", () => {
  it("allows existing flows while the administrator setting is disabled", () => {
    expect(isMoneyRequestAllowedByVerification(false, null)).toBe(true);
    expect(isMoneyRequestAllowedByVerification(false, "pending")).toBe(true);
  });

  it("requires approval when the administrator enables the gate", () => {
    expect(isMoneyRequestAllowedByVerification(true, null)).toBe(false);
    expect(isMoneyRequestAllowedByVerification(true, "pending")).toBe(false);
    expect(isMoneyRequestAllowedByVerification(true, "rejected")).toBe(false);
    expect(isMoneyRequestAllowedByVerification(true, "approved")).toBe(true);
  });

  it("returns the exact Arabic message and direct verification route for both money flows", () => {
    for (const flow of ["deposit", "withdrawal"] as const) {
      const prompt = getMoneyRequestVerificationPrompt(true, "pending");
      expect(prompt).toEqual({ message: ACCOUNT_VERIFICATION_REQUIRED_MESSAGE, actionLabel: ACCOUNT_VERIFICATION_ACTION_LABEL, route: ACCOUNT_VERIFICATION_ROUTE });
      expect(prompt?.message).toBe("يرجى توثيق حسابك أولًا لإتمام العملية");
      expect(prompt?.actionLabel).toBe("توثيق الحساب");
      expect(prompt?.route).toBe("/account-verification");
      expect(flow).toMatch(/deposit|withdrawal/);
    }
    expect(getMoneyRequestVerificationPrompt(false, null)).toBeNull();
    expect(getMoneyRequestVerificationPrompt(true, "approved")).toBeNull();
  });

  it("keeps payment methods inaccessible while checking, on errors, or until approval when forced", () => {
    expect(getMoneyRequestAccessState({ checking: true, unavailable: false, requiredBeforeMoney: true, status: null })).toBe("checking");
    expect(getMoneyRequestAccessState({ checking: false, unavailable: true, requiredBeforeMoney: false, status: null })).toBe("unavailable");
    expect(getMoneyRequestAccessState({ checking: false, unavailable: false, requiredBeforeMoney: true, status: "not_submitted" })).toBe("verification_required");
    expect(getMoneyRequestAccessState({ checking: false, unavailable: false, requiredBeforeMoney: true, status: "pending" })).toBe("verification_required");
    expect(getMoneyRequestAccessState({ checking: false, unavailable: false, requiredBeforeMoney: true, status: "approved" })).toBe("allowed");
    expect(getMoneyRequestAccessState({ checking: false, unavailable: false, requiredBeforeMoney: false, status: "pending" })).toBe("allowed");
    expect(getMoneyRequestAccessState({ checking: false, unavailable: false, requiredBeforeMoney: false, status: "approved", serverBlocked: true })).toBe("verification_required");
  });
});
