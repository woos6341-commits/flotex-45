import { describe, expect, it } from "vitest";
import { formatMoneyMinorUnits, parseMoneyMinorUnits, resolveTransactionMetadata } from "../shared/transactions";

describe("customer transaction semantics", () => {
  it.each([
    ["adjustment", "125.50", "إيداع", "تمت إضافة الأموال", "credit", "125.50"],
    ["adjustment", "-50.00", "خصم", "تم خصم الأموال", "debit", "-50.00"],
    ["deposit", "500.00", "إيداع", "تمت إضافة الأموال", "credit", "500.00"],
    ["withdrawal", "50.00", "سحب", "تم سحب الأموال", "debit", "-50.00"],
    ["withdrawal", "-50.00", "سحب", "تم سحب الأموال", "debit", "-50.00"],
    ["loss", "10.00", "خسائر", "تم خصم الأموال", "debit", "-10.00"],
  ])("resolves %s amount %s without double signs", (type, amount, title, description, direction, signedAmount) => {
    expect(resolveTransactionMetadata({ type, amount, status: "approved" })).toMatchObject({ customerTitle: title, customerDescription: description, direction, signedAmount });
  });
  it("never claims a pending or rejected transaction has succeeded", () => {
    expect(resolveTransactionMetadata({ type: "deposit", amount: "500.00", status: "pending" }).customerDescription).toBe("العملية قيد المراجعة");
    expect(resolveTransactionMetadata({ type: "deposit", amount: "500.00", status: "rejected" }).customerDescription).toBe("تم رفض العملية ولم يتغير الرصيد");
  });
  it("does not reuse old administrative labels", () => {
    expect(resolveTransactionMetadata({ type: "adjustment", amount: "-50.00", customerTitle: "تعديل إداري", customerDescription: "اعتماد إداري" })).toMatchObject({customerTitle:"خصم",customerDescription:"تم خصم الأموال"});
  });
  it("shows explicit 1xBet withdrawal credits and deposit debits with their reasons", () => {
    expect(resolveTransactionMetadata({ type: "adjustment", amount: "100.00", status: "approved", direction: "credit", source: "game_topup", customerTitle: "سحب 1xBet", customerDescription: "إضافة 100.00 ج.م من طلب سحب 1xBet GT-123 بعد موافقة الإدارة." })).toMatchObject({ customerTitle: "سحب 1xBet", customerDescription: "إضافة 100.00 ج.م من طلب سحب 1xBet GT-123 بعد موافقة الإدارة.", direction: "credit", signedAmount: "100.00" });
    expect(resolveTransactionMetadata({ type: "adjustment", amount: "75.00", status: "approved", direction: "debit", source: "game_topup", customerTitle: "إيداع 1xBet", customerDescription: "خصم 75.00 ج.م لإيداع 1xBet." })).toMatchObject({ customerTitle: "إيداع 1xBet", customerDescription: "خصم 75.00 ج.م لإيداع 1xBet.", direction: "debit", signedAmount: "-75.00" });
  });
  it("keeps savings fees separate from principal savings debits", () => {
    expect(resolveTransactionMetadata({ type: "fee", amount: "1.00", status: "approved", direction: "debit", source: "savings_fee", customerTitle: "رسوم الإدخار", customerDescription: "رسوم الإدخار بقيمة 1.00 جنيه." })).toMatchObject({
      customerTitle: "رسوم الإدخار",
      customerDescription: "رسوم الإدخار بقيمة 1.00 جنيه.",
    });
    expect(resolveTransactionMetadata({ type: "savings_principal", amount: "1000.00", status: "approved", direction: "debit", source: "savings_principal", customerTitle: "خصم الإدخار", customerDescription: "خصم مبلغ 1000 جنيه." })).toMatchObject({
      customerTitle: "خصم للادخار",
      customerDescription: "تم خصم المبلغ بنجاح وتحويله إلى حساب الادخار الخاص بك",
    });
  });
});

describe("exact piastre arithmetic", () => {
  it("adds and subtracts decimal text without hidden rounding", () => {
    expect(parseMoneyMinorUnits("+100.00",true)).toBe(10000);
    expect(formatMoneyMinorUnits(parseMoneyMinorUnits("0.10") + parseMoneyMinorUnits("0.20"))).toBe("0.30");
    expect(formatMoneyMinorUnits(parseMoneyMinorUnits("125.50") + parseMoneyMinorUnits("-25.25", true))).toBe("100.25");
  });
  it.each(["NaN","Infinity","1.001","1e2","", "9999999999999.00"])("rejects malformed or out-of-range %s", value => {
    expect(()=>parseMoneyMinorUnits(value, true)).toThrow();
  });
});
