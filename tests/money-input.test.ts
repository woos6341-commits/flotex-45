import { describe, expect, it } from "vitest";
import { tryParseMoneyMinorUnits } from "../shared/transactions";

describe("safe parsing for editable money fields", () => {
  it("returns null for empty and incomplete text instead of throwing", () => {
    expect(tryParseMoneyMinorUnits("")).toBeNull();
    expect(tryParseMoneyMinorUnits("12.")).toBeNull();
  });

  it("parses valid Egyptian pound values exactly to piastres", () => {
    expect(tryParseMoneyMinorUnits("1500.01")).toBe(150001);
  });

  it("returns null for malformed, negative, and out-of-range values", () => {
    expect(tryParseMoneyMinorUnits("1.234")).toBeNull();
    expect(tryParseMoneyMinorUnits("-1.00")).toBeNull();
    expect(tryParseMoneyMinorUnits("1000000000000.00")).toBeNull();
  });

  it("supports negative values only when explicitly requested", () => {
    expect(tryParseMoneyMinorUnits("-12.34", true)).toBe(-1234);
  });
});
