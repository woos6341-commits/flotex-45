import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "app/savings.tsx"), "utf8");

describe("persistent savings confirmation", () => {
  it("places the existing confirm action in a dock after the scrolling content", () => {
    const scrollEnd = source.indexOf("</ScrollView>");
    const dock = source.indexOf("savingsStyles.submitDock");
    const button = source.indexOf('<ActionButton label={create.isPending ? "جارٍ إرسال الطلب..." : "تأكيد طلب الادخار"}');
    expect(scrollEnd).toBeGreaterThan(-1);
    expect(dock).toBeGreaterThan(scrollEnd);
    expect(button).toBeGreaterThan(dock);
    expect(source).toContain("تأكيد طلب الادخار");
  });

  it("respects the safe area and lifts the dock above the iOS keyboard", () => {
    expect(source).toContain("paddingBottom: Math.max(insets.bottom, compact ? 8 : 12)");
    expect(source).toContain("marginBottom: keyboardOffset");
    expect(source).toContain('Keyboard.addListener("keyboardWillShow"');
  });

  it("preserves the existing rate, fee, balance validation and expected-return calculation", () => {
    expect(source).toContain("calculateExpectedInterestAtRate(amount, ratePercentToPpm(ratePercent))");
    expect(source).toContain("const feeMinor = tryParseMoneyMinorUnits(feeAmount)");
    expect(source).toContain("if (requiredMinor > availableMinor)");
    expect(source).toContain("utils.savings.mine.invalidate()");
  });

  it("keeps all key money values visible in a compact phone summary", () => {
    expect(source).toContain("const compact = width <= 380;");
    expect(source).toContain("function SummaryRow(");
    for (const label of ["أصل الادخار", "العائد المتوقع", "رسوم الطلب عند الموافقة", "إجمالي الخصم عند الموافقة", "الصافي التقديري بعد أول عائد والرسوم"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("product.maturityLabel");
  });

  it("renders the live expected return immediately after the editable amount field", () => {
    const amountInput = source.indexOf('accessibilityLabel="مبلغ الادخار"');
    const expectedReturn = source.indexOf("العائد المتوقع ·", amountInput);
    const quickAmounts = source.indexOf("savingsStyles.quickRow", amountInput);
    expect(amountInput).toBeGreaterThan(-1);
    expect(expectedReturn).toBeGreaterThan(amountInput);
    expect(quickAmounts).toBeGreaterThan(expectedReturn);
    expect(source).toContain("formatExpectedSavingsInterest(expected)");
  });

  it("requests the decimal soft keyboard and keeps keyboard-aware scrolling enabled", () => {
    expect(source).toContain('inputMode="decimal"');
    expect(source).toContain('keyboardType="decimal-pad"');
    expect(source).toContain("showSoftInputOnFocus");
    expect(source).toContain("keyboardGap={88}");
    expect(source).toContain("KeyboardAwareScrollView as ScrollView");
  });
});
