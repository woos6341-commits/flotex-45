import { describe, expect, it } from "vitest";
import { isBellEligibleSuccessfulTransaction } from "../shared/transactions";

describe("successful transaction bell allow-list", () => {
  it.each(["deposit", "withdrawal", "transfer"])("includes approved %s operations", (type) => {
    expect(isBellEligibleSuccessfulTransaction({ type, status: "approved" })).toBe(true);
  });

  it("includes savings principal, refunds, and realized savings returns by source", () => {
    expect(isBellEligibleSuccessfulTransaction({ type: "adjustment", source: "savings_principal", status: "approved" })).toBe(true);
    expect(isBellEligibleSuccessfulTransaction({ type: "adjustment", source: "savings_refund", status: "approved" })).toBe(true);
    expect(isBellEligibleSuccessfulTransaction({ type: "profit", source: "savings_profit", status: "approved" })).toBe(true);
  });

  it("includes game top-ups but excludes fees and unrelated balance adjustments", () => {
    expect(isBellEligibleSuccessfulTransaction({ type: "adjustment", source: "game_topup", status: "approved" })).toBe(true);
    expect(isBellEligibleSuccessfulTransaction({ type: "fee", source: "savings_fee", status: "approved" })).toBe(false);
    expect(isBellEligibleSuccessfulTransaction({ type: "adjustment", source: "admin_adjustment", status: "approved" })).toBe(false);
    expect(isBellEligibleSuccessfulTransaction({ type: "adjustment", source: "coin_buy", status: "approved" })).toBe(false);
  });

  it("never marks pending, rejected, or cancelled entries as successful", () => {
    for (const status of ["pending", "rejected", "cancelled"]) {
      expect(isBellEligibleSuccessfulTransaction({ type: "deposit", status })).toBe(false);
    }
  });
});
