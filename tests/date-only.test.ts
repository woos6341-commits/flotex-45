import { describe, expect, it } from "vitest";
import { formatLocalDateOnly, getDaysInMonth, isDateOnlyNotFuture, isValidDateOnly } from "../shared/date-only";

describe("date-only birth dates", () => {
  const today = "2026-11-11";

  it("rejects a future date", () => {
    expect(isDateOnlyNotFuture("2026-11-12", today)).toBe(false);
    expect(isDateOnlyNotFuture("2027-01-01", today)).toBe(false);
  });

  it("accepts today and an earlier date", () => {
    expect(isDateOnlyNotFuture(today, today)).toBe(true);
    expect(isDateOnlyNotFuture("1999-12-31", today)).toBe(true);
  });

  it("rejects malformed and impossible calendar dates", () => {
    expect(isDateOnlyNotFuture("2026-02-29", today)).toBe(false);
    expect(isDateOnlyNotFuture("11/11/2026", today)).toBe(false);
    expect(isDateOnlyNotFuture("2026-13-01", today)).toBe(false);
  });

  it("handles leap years and formats local calendar fields without UTC conversion", () => {
    expect(isValidDateOnly("2000-02-29")).toBe(true);
    expect(isValidDateOnly("1900-02-29")).toBe(false);
    expect(getDaysInMonth(2024, 2)).toBe(29);
    expect(formatLocalDateOnly(new Date(2026, 10, 11, 23, 59))).toBe(today);
  });
});
