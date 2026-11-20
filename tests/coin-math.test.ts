import { describe, expect, it } from "vitest";
import { addDecimal, subtractDecimal, quoteCoinOrder } from "../server/coin-math";
import { beginCoinOperation, finishCoinOperation, newCoinOperationAttempt } from "../shared/coin-operation";
describe("integer-backed coin finance and submission retries", () => {
  it("retains microcoins even at large balances", () => {
    expect(addDecimal("99999999999.999999", "0.000001", 6)).toBe("100000000000.000000");
    expect(subtractDecimal("100000000000.000000", "0.000001", 6)).toBe("99999999999.999999");
    expect(addDecimal("0.10", "0.20", 2)).toBe("0.30");
  });
  it("rounds product once half-up and applies flat enabled fees", () => {
    expect(quoteCoinOrder("0.0001", "50.00", "0.00", "buy")).toEqual({ gross: "0.01", fee: "0.00", total: "0.01" });
    expect(quoteCoinOrder("2", "50", "1", "buy").total).toBe("101.00");
    expect(quoteCoinOrder("2", "50", "1", "sell").total).toBe("99.00");
  });
  it("rejects underflow, overflows and zero net orders", () => {
    expect(() => subtractDecimal("1.000000", "1.000001", 6)).toThrow();
    expect(() => addDecimal("999999999999.999999", "0.000001", 6)).toThrow();
    expect(() => quoteCoinOrder("1000000000", "99999999999", "1", "buy")).toThrow();
    expect(() => quoteCoinOrder("0.01", "50", "1", "sell")).toThrow();
  });
  it("blocks duplicate taps and reuses a key after uncertain network failure", () => {
    const attempt = newCoinOperationAttempt();
    const first = beginCoinOperation(attempt, "buy:2", "FC-TEST");
    expect(beginCoinOperation(attempt, "buy:2", "FC-TEST")).toBeNull();
    finishCoinOperation(attempt, false);
    expect(beginCoinOperation(attempt, "buy:2", "FC-TEST")).toBe(first);
    finishCoinOperation(attempt, false);
    const changed = beginCoinOperation(attempt, "buy:3", "FC-TEST"); expect(changed).not.toBe(first);
    finishCoinOperation(attempt, true);
    expect(beginCoinOperation(attempt, "buy:3", "FC-TEST")).not.toBe(changed);
  });
});
