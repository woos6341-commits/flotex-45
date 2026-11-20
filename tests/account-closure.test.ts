import { describe, expect, it } from "vitest";
import { evaluateAccountClosure } from "../shared/account-closure";

describe("account closure eligibility", () => {
  it("allows only zero balances and no open financial obligations", () => {
    expect(evaluateAccountClosure({
      walletBalance: "0.00",
      reservedWithdrawals: "0.00",
      reservedOrders: "0.00",
      reservedTransfers: "0.00",
      reservedSavings: "0.00",
      coinBalance: "0.000000",
      reservedCoin: "0.000000",
      goldGrams: ["0.000000"],
      positionQuantities: ["0.000000"],
    })).toEqual({ eligible: true, blockers: [] });
  });

  it.each([
    { walletBalance: "0.01" },
    { reservedWithdrawals: "0.01" },
    { reservedOrders: "0.01" },
    { reservedTransfers: "0.01" },
    { reservedSavings: "0.01" },
    { coinBalance: "0.000001" },
    { reservedCoin: "0.000001" },
    { goldGrams: ["0.000001"] },
    { positionQuantities: ["0.000001"] },
  ])("blocks closure when a wallet, reserve, or asset remains: %o", (facts) => {
    expect(evaluateAccountClosure(facts).eligible).toBe(false);
  });

  it.each([
    "hasPendingTransaction",
    "hasPendingPaymentRequest",
    "hasPendingMoneyTransfer",
    "hasPendingOrder",
    "hasPendingCoinOrderOrTransfer",
    "hasPendingGoldOrder",
    "hasOpenSavingsPlan",
    "hasUnpaidSavingsPayout",
    "hasPendingCashLedgerEntry",
  ] as const)("blocks closure for %s", (key) => {
    expect(evaluateAccountClosure({ [key]: true }).eligible).toBe(false);
  });

  it("ignores exact numeric zero encodings without using floating point", () => {
    expect(evaluateAccountClosure({ walletBalance: "000.000", coinBalance: "0", goldGrams: ["+0.000000"] }).eligible).toBe(true);
  });
});
