import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const integratedFiles = [
  "app/transfer.tsx", "app/support.tsx", "app/sessions.tsx", "app/security-pin.tsx",
  "app/savings.tsx", "app/savings-how-to.tsx", "app/savings-history.tsx",
  "app/coin-wallet.tsx", "app/phone-verification.tsx", "app/coin-send.tsx",
  "components/payments/PaymentFlow.tsx", "components/CoinOrderForm.tsx",
  "app/dev/theme-lab.tsx", "app/(tabs)/wallet.tsx", "app/(tabs)/profile.tsx",
  "app/(tabs)/activity.tsx", "app/control.tsx",
  "components/payments-admin/RequestsReview.tsx", "components/money-transfers/RequestsAdmin.tsx",
];
const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

// Unchanged screens retain the read-only supplied original; savings uses the reviewed redesign baseline.
// The entire button JSX is signed (styles, text, icons, handlers and props).
// Whitespace/comments are normalized by the TypeScript printer.
const originalButtons: Record<string, { count: number; sha256: string }> = {
  "app/savings.tsx": { count: 6, sha256: "dc5c3116345ab349ffd46781bc3b49b84af739d18abed8002442b0658fd5f9ad" },
  "app/savings-history.tsx": { count: 3, sha256: "b62f4aae0d42263b9982b6e6889c7c9339921cbeec20035e4833b5a610e8dc82" },
  "components/atheer-ui.tsx": { count: 1, sha256: "f81a8e530545a5ed569327bbebc15d3c4507ed50e002ddb9b1802e2c039d68f3" },
  "app/transfer.tsx": { count: 7, sha256: "799f69b72257cbc738506239a605261ec2bdc95ed4aada47b23ce799586591b3" },
  "components/payments/PaymentFlow.tsx": { count: 23, sha256: "f9d6c2d8e3d9e4243c94e70d7dace994275da6b62ae3e04f63f66cd6878f93b4" },
  "components/payments-admin/RequestsReview.tsx": { count: 10, sha256: "8c748fe1476bb6c6dffb204b9e28f5bbd55a7ce0f590fb61ab5af4eda668202c" },
  "components/money-transfers/RequestsAdmin.tsx": { count: 9, sha256: "0d07dd95d2966c740722a726f115e03f99a3f1005e16566b51a7ae8da7c44af6" },
};
function buttonSignature(file: string) {
  const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const printer = ts.createPrinter({ removeComments: true });
  const buttons: string[] = [];
  const visit = (node: ts.Node) => {
    // The payment review now has a separate, additional pagination component.
    // Exclude its new controls while still hashing every original button unchanged.
    if (file === "components/payments-admin/RequestsReview.tsx" && ts.isFunctionDeclaration(node) && node.name?.text === "PendingRequestList") return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName.getText(tree) : node.tagName.getText(tree);
      if (["Pressable", "ActionButton", "PrimaryButton", "SecondaryButton", "ReviewButton"].includes(tag)) {
        // A retry control was added for the newly introduced selected-request query.
        if (file === "components/payments-admin/RequestsReview.tsx" && tag === "ReviewButton" && node.getText(tree).includes('label="إعادة المحاولة"')) return;
        buttons.push(printer.printNode(ts.EmitHint.Unspecified, node, tree));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { count: buttons.length, sha256: createHash("sha256").update(JSON.stringify(buttons)).digest("hex") };
}

describe("keyboard integration coverage", () => {
  it("uses native Android focus for the decimal field without a competing press-in focus call", () => {
    const field = source("app/savings.tsx").match(/<TextInput[\s\S]*?accessibilityLabel="مبلغ الادخار"[\s\S]*?\/>/)?.[0] ?? "";
    expect(field).not.toBe("");
    expect(field).toContain("value={amount}");
    expect(field).toContain("onChangeText={setAmount}");
    expect(field).not.toContain("onPressIn");
    expect(field).toContain('inputMode="decimal"');
    expect(field).toContain('keyboardType="decimal-pad"');
    expect(field).toContain("showSoftInputOnFocus={true}");
    expect(field).toContain("onFocus={() => setFocused(true)}");
    expect(source("app.config.ts")).toContain('softwareKeyboardLayoutMode: "resize"');
    expect(source("app/savings.tsx")).toContain('keyboardDismissMode="none"');
    expect(source("app/savings.tsx")).toContain('keyboardShouldPersistTaps="always"');
    expect(source("app/savings.tsx")).toContain('keyboardAware={Platform.OS !== "android"}');
  });
  it("does not refetch savings queries during native keyboard/window focus changes", () => {
    const savings = source("app/savings.tsx");
    expect(savings).toContain("refetchOnWindowFocus: false");
    expect(savings).not.toContain("refetchOnWindowFocus: true");
    expect(savings).not.toContain("Keyboard.dismiss()");
  });
  it.each(integratedFiles)("uses a single keyboard-aware scrolling owner in %s", (file) => {
    const text = source(file);
    expect(text).toContain('import { KeyboardAwareScrollView as ScrollView } from "@/components/KeyboardAwareScrollView"');
    expect(text.match(/KeyboardAwareScrollView as ScrollView/g)).toHaveLength(1);
    expect(text).not.toContain("automaticallyAdjustKeyboardInsets");
    expect(text).not.toContain("<KeyboardAvoidingView");
  });
  it.each(["app/transfer.tsx", "components/payments/PaymentFlow.tsx", "components/payments-admin/RequestsReview.tsx", "components/money-transfers/RequestsAdmin.tsx"])("puts input modals inside their own scrolling root in %s", (file) => {
    const text = source(file);
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inputModals: ts.JsxElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "Modal" && node.getText(tree).includes("<TextInput")) inputModals.push(node);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(inputModals.length).toBeGreaterThan(0);
    inputModals.forEach((modal) => {
      const root = modal.children.find((child) => ts.isJsxElement(child));
      expect(root && ts.isJsxElement(root) ? root.openingElement.tagName.getText(tree) : null).toBe("ScrollView");
    });
  });
  it("keeps screen shells free of duplicate keyboard avoidance", () => {
    expect(source("components/atheer-ui.tsx")).not.toContain("<KeyboardAvoidingView");
    expect(source("components/screen-container.tsx")).not.toContain("<KeyboardAvoidingView");
    expect(source("components/KeyboardAwareScrollView.tsx")).toContain("automaticallyAdjustKeyboardInsets={false}");
  });
});

describe("original resting button preservation", () => {
  it.each(Object.entries(originalButtons))("preserves the full original button JSX in %s", (file, expected) => {
    expect(buttonSignature(file)).toEqual(expected);
  });
});
