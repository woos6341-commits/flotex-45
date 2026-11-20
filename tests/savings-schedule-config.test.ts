import { describe, expect, it } from "vitest";
import {
  getSavingsAutoPayoutRetryDelayMs,
  isSavingsAutoPayoutScheduleRuntime,
  SAVINGS_AUTO_PAYOUT_CRON,
  SAVINGS_AUTO_PAYOUT_JOB_NAME,
  SAVINGS_AUTO_PAYOUT_PATH,
} from "../server/savings-schedule-config";

describe("savings heartbeat registration configuration", () => {
  it("uses a six-field schedule at the minimum supported interval and the scheduled callback namespace", () => {
    expect(SAVINGS_AUTO_PAYOUT_CRON).toBe("0 * * * * *");
    expect(SAVINGS_AUTO_PAYOUT_CRON.split(" ")).toHaveLength(6);
    expect(SAVINGS_AUTO_PAYOUT_PATH).toBe("/api/scheduled/savings-auto-payout");
    expect(SAVINGS_AUTO_PAYOUT_PATH.startsWith("/api/scheduled/")).toBe(true);
    expect(SAVINGS_AUTO_PAYOUT_JOB_NAME).toBe("savings-auto-payout");
  });

  it("never creates a remote schedule in Preview or development", () => {
    expect(isSavingsAutoPayoutScheduleRuntime("development")).toBe(false);
    expect(isSavingsAutoPayoutScheduleRuntime("test")).toBe(false);
    expect(isSavingsAutoPayoutScheduleRuntime(undefined)).toBe(false);
    expect(isSavingsAutoPayoutScheduleRuntime("production")).toBe(true);
  });

  it("backs off transient registration failures and caps retries at five minutes", () => {
    expect([0, 1, 2, 3, 4].map(getSavingsAutoPayoutRetryDelayMs)).toEqual([5_000, 15_000, 60_000, 300_000, 300_000]);
    expect(getSavingsAutoPayoutRetryDelayMs(-1)).toBe(5_000);
    expect(getSavingsAutoPayoutRetryDelayMs(Number.NaN)).toBe(5_000);
  });
});
