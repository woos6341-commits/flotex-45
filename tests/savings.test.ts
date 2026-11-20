import { describe, expect, it } from "vitest";
import {
  addSavingsPeriod,
  addSavingsRefundPeriod,
  calculateExpectedInterest,
  formatExpectedSavingsInterest,
  formatSavingsCountdown,
  getSavingsMinimumFundingShortfallMinor,
  getSavingsPayoutCountdown,
  getSavingsProduct,
  getSavingsReservationReleaseAmount,
  isSavingsAutoPayoutDue,
  roundInterestToWallet,
  savingsPeriodKey,
  validateSavingsAmount,
} from "../shared/savings";

describe("Flotex savings products", () => {
  it("keeps the requested daily, monthly, and yearly rates", () => {
    expect(getSavingsProduct("daily").ratePercent).toBe("0.0548");
    expect(getSavingsProduct("monthly").ratePercent).toBe("1.6667");
    expect(getSavingsProduct("yearly").ratePercent).toBe("20.0000");
  });

  it("calculates the example without hiding fractional expected interest", () => {
    expect(calculateExpectedInterest("1000.00", "daily")).toBe("0.5480");
    expect(roundInterestToWallet("0.5480")).toBe("0.55");
  });

  it("formats only the displayed expected return to two decimals and removes trailing zeroes", () => {
    expect(formatExpectedSavingsInterest("0.5480")).toBe("0.55");
    expect(formatExpectedSavingsInterest("10.1000")).toBe("10.1");
    expect(formatExpectedSavingsInterest("10.0000")).toBe("10");
    expect(formatExpectedSavingsInterest("0.0049")).toBe("0");
    expect(calculateExpectedInterest("1000.00", "daily")).toBe("0.5480");
  });

  it("uses full-period UTC keys and advances the correct period", () => {
    const start = new Date("2026-10-29T20:00:00.000Z");
    expect(savingsPeriodKey("daily", start)).toBe("daily:2026-10-29");
    expect(savingsPeriodKey("monthly", start)).toBe("monthly:2026-10");
    expect(savingsPeriodKey("yearly", start)).toBe("yearly:2026");
    expect(addSavingsPeriod(start, "daily").toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(addSavingsPeriod(start, "monthly").toISOString()).toBe("2026-11-29T20:00:00.000Z");
    expect(addSavingsPeriod(start, "yearly").toISOString()).toBe("2027-10-29T20:00:00.000Z");
    expect(addSavingsPeriod(new Date("2026-01-31T20:00:00.000Z"), "monthly").toISOString()).toBe("2026-02-28T20:00:00.000Z");
    expect(addSavingsPeriod(new Date("2024-02-29T20:00:00.000Z"), "yearly").toISOString()).toBe("2025-02-28T20:00:00.000Z");
  });

  it("keeps monthly and yearly anniversaries anchored after short months and leap years", () => {
    const monthlyAnchor = new Date("2026-01-31T20:00:00.000Z");
    const february = addSavingsPeriod(monthlyAnchor, "monthly", monthlyAnchor);
    expect(february.toISOString()).toBe("2026-02-28T20:00:00.000Z");
    expect(addSavingsPeriod(february, "monthly", monthlyAnchor).toISOString()).toBe("2026-03-31T20:00:00.000Z");

    const leapDayAnchor = new Date("2024-02-29T20:00:00.000Z");
    const nonLeapYear = addSavingsPeriod(leapDayAnchor, "yearly", leapDayAnchor);
    expect(nonLeapYear.toISOString()).toBe("2025-02-28T20:00:00.000Z");
    expect(addSavingsPeriod(nonLeapYear, "yearly", leapDayAnchor).toISOString()).toBe("2026-02-28T20:00:00.000Z");
    const nextLeapYear = addSavingsPeriod(new Date("2027-02-28T20:00:00.000Z"), "yearly", leapDayAnchor);
    expect(nextLeapYear.toISOString()).toBe("2028-02-29T20:00:00.000Z");
  });

  it("shows a countdown before maturity and marks the payout due at the exact boundary", () => {
    const dueAt = "2026-11-01T14:00:00.000Z";
    const dueMs = new Date(dueAt).getTime();
    expect(getSavingsPayoutCountdown(dueAt, dueMs - 1).isDue).toBe(false);
    expect(getSavingsPayoutCountdown(dueAt, dueMs - 1).remainingMs).toBe(1);
    expect(getSavingsPayoutCountdown(dueAt, dueMs).isDue).toBe(true);
    expect(getSavingsPayoutCountdown(null, dueMs).remainingMs).toBeNull();
    expect(formatSavingsCountdown(90_061_000)).toBe("1 يوم و 1 ساعة و 1 دقيقة و 1 ثانية");
  });

  it("waits a full five-minute grace period before automatic payout", () => {
    const dueAt = "2026-11-01T14:00:00.000Z";
    const dueMs = new Date(dueAt).getTime();
    expect(isSavingsAutoPayoutDue(dueAt, dueMs + 299_999)).toBe(false);
    expect(isSavingsAutoPayoutDue(dueAt, dueMs + 300_000)).toBe(true);
    expect(isSavingsAutoPayoutDue(null, dueMs + 600_000)).toBe(false);
  });

  it("releases the full principal and fee reserve and supports legacy principal-only reserves", () => {
    expect(getSavingsReservationReleaseAmount("1000.00", "1.00", "1001.00")).toBe("1001.00");
    expect(getSavingsReservationReleaseAmount("1000.00", "1.00", "1000.00")).toBe("1000.00");
    expect(() => getSavingsReservationReleaseAmount("1000.00", "1.00", "999.99")).toThrow("تعذر تحرير");
  });

  it("allows refund 48 hours after the request for every frequency", () => {
    const start = new Date("2026-10-29T20:00:00.000Z");
    for (const frequency of ["daily", "monthly", "yearly"] as const) {
      expect(addSavingsRefundPeriod(start, frequency).toISOString()).toBe("2026-10-31T20:00:00.000Z");
    }
  });

  it("normalizes valid amounts and rejects zero, negative, and over-precise values", () => {
    expect(validateSavingsAmount(" 1000.5 ")).toBe("1000.50");
    expect(() => validateSavingsAmount("0")).toThrow("أكبر من صفر");
    expect(() => validateSavingsAmount("-1.00")).toThrow();
    expect(() => validateSavingsAmount("10.123")).toThrow();
  });

  it("computes the minimum funding shortfall including fees in whole piastres", () => {
    expect(getSavingsMinimumFundingShortfallMinor("1000.00", "1.00", "500.00")).toBe(50_100);
    expect(getSavingsMinimumFundingShortfallMinor("1000.00", "1.00", "1001.00")).toBe(0);
    expect(getSavingsMinimumFundingShortfallMinor("1000.00", "1.00", null)).toBeNull();
  });

  it("enforces the configurable minimum savings amount", () => {
    expect(() => validateSavingsAmount("999.99", "1000.00")).toThrow("1000");
    expect(validateSavingsAmount("1000.00", "1000.00")).toBe("1000.00");
  });
});
