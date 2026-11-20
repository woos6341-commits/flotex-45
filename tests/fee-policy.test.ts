import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_POLICY,
  assertWithdrawalFeeCoverage,
  calculateTransferFee,
  calculateWithdrawalFee,
  getWithdrawalFeeMinorUnits,
  getTransferFeeMinorUnits,
  validateFeePolicy,
} from "../shared/fee-policy";

describe("Flotex fee policy", () => {
  it("applies the requested inclusive withdrawal bands exactly", () => {
    expect(calculateWithdrawalFee("50.00", DEFAULT_FEE_POLICY)).toBe("5.00");
    expect(calculateWithdrawalFee("1000.00", DEFAULT_FEE_POLICY)).toBe("5.00");
    expect(calculateWithdrawalFee("1000.01", DEFAULT_FEE_POLICY)).toBe("10.00");
    expect(calculateWithdrawalFee("1500.00", DEFAULT_FEE_POLICY)).toBe("10.00");
    expect(calculateWithdrawalFee("1500.01", DEFAULT_FEE_POLICY)).toBe("15.00");
    expect(calculateWithdrawalFee("40000.00", DEFAULT_FEE_POLICY)).toBe("15.00");
  });

  it("keeps transfer fee fixed at one pound and allows each fee independently to be disabled", () => {
    expect(calculateTransferFee(DEFAULT_FEE_POLICY)).toBe("1.00");
    expect(getTransferFeeMinorUnits({ ...DEFAULT_FEE_POLICY, transferEnabled: false })).toBe(0);
    expect(getWithdrawalFeeMinorUnits("1500.01", { ...DEFAULT_FEE_POLICY, withdrawalEnabled: false })).toBe(0);
  });

  it("validates a new contiguous tier and open final band", () => {
    const changed = validateFeePolicy({
      ...DEFAULT_FEE_POLICY,
      withdrawalTiers: [
        ...DEFAULT_FEE_POLICY.withdrawalTiers.slice(0, 2),
        { ...DEFAULT_FEE_POLICY.withdrawalTiers[2], maximumAmount: "2000.00" },
        { id: "withdrawal-over-2000", minimumAmount: "2000.01", maximumAmount: null, feeAmount: "20.00" },
      ],
    });
    expect(calculateWithdrawalFee("2000.01", changed)).toBe("20.00");
  });

  it("rejects gaps, overlaps, negative fees and an uncovered upper range", () => {
    const tiers = DEFAULT_FEE_POLICY.withdrawalTiers;
    expect(() => validateFeePolicy({
      ...DEFAULT_FEE_POLICY,
      withdrawalTiers: [tiers[0], { ...tiers[1], minimumAmount: "1000.02" }, tiers[2]],
    })).toThrow(/متتابعة بلا فجوات/);
    expect(() => validateFeePolicy({
      ...DEFAULT_FEE_POLICY,
      withdrawalTiers: [tiers[0], { ...tiers[1], minimumAmount: "999.99" }, tiers[2]],
    })).toThrow(/متداخلة/);
    expect(() => validateFeePolicy({
      ...DEFAULT_FEE_POLICY,
      transferFeeAmount: "-1.00",
    })).toThrow();
    expect(() => validateFeePolicy({
      ...DEFAULT_FEE_POLICY,
      withdrawalTiers: [tiers[0], tiers[1], { ...tiers[2], maximumAmount: "2000.00" }],
    })).toThrow(/الشريحة الأخيرة مفتوحة/);
  });

  it("does not expose an editable deposit fee", () => {
    expect(DEFAULT_FEE_POLICY).not.toHaveProperty("depositFeeAmount");
  });

  it("requires the first enabled band to cover the configured minimum withdrawal", () => {
    expect(() => assertWithdrawalFeeCoverage(DEFAULT_FEE_POLICY, "49.99")).toThrow(/لا تغطي الحد الأدنى للسحب/);
    expect(() => assertWithdrawalFeeCoverage(DEFAULT_FEE_POLICY, "50.00")).not.toThrow();
    expect(() => assertWithdrawalFeeCoverage({ ...DEFAULT_FEE_POLICY, withdrawalEnabled: false, withdrawalTiers: [] }, "1.00")).not.toThrow();
  });
});
