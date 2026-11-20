import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyAmount } from "../lib/currency";

describe("EGP currency formatting", () => {
  it("formats amounts as Egyptian pounds with Arabic display suffix", () => {
    expect(formatMoney("1000")).toBe("1,000.00 ج.م");
    expect(formatMoney(0)).toBe("0.00 ج.م");
  });

  it("formats the numeric amount without duplicating its suffix in split-unit layouts", () => {
    expect(formatMoneyAmount("1000")).toBe("1,000.00");
  });
});
