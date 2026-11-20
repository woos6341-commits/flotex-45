import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };

const state = vi.hoisted(() => ({ selected: null as any, pending: [] as any[], selectedCalls: [] as any[], listCalls: [] as any[] }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const wrap = (tag: string) => ({ children }: any) => React.createElement(tag, null, children);
  return { View: wrap("div"), Text: wrap("span"), Pressable: wrap("button"), Modal: wrap("div"), TextInput: () => null, Image: () => null, ActivityIndicator: () => React.createElement("i", null, "loading"), StyleSheet: { create: (styles: any) => styles } };
});
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("@/components/KeyboardAwareScrollView", async () => {
  const React = await import("react");
  return { KeyboardAwareScrollView: ({ children }: any) => React.createElement("div", null, children) };
});
vi.mock("@/components/atheer-ui", async () => {
  const React = await import("react");
  return { Card: ({ children }: any) => React.createElement("section", null, children), EmptyState: ({ title }: any) => React.createElement("span", null, title), Pill: ({ children }: any) => React.createElement("span", null, children), formatMoney: (value: any) => String(value) };
});
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ admin: { pendingPaymentRequests: { invalidate: vi.fn() }, paymentRequestById: { invalidate: vi.fn() }, paymentRequestArchive: { invalidate: vi.fn() } } }),
  admin: {
    reviewRequest: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    receipt: { useQuery: () => ({}) },
    paymentRequestArchive: { useQuery: () => ({ data: { items: [], total: 0 }, isLoading: false, isError: false }) },
    paymentRequestById: { useQuery: (input: any, options: any) => { state.selectedCalls.push({ input, options }); return { data: state.selected, isFetching: false, isError: false, refetch: vi.fn() }; } },
    pendingPaymentRequests: { useQuery: (input: any) => { state.listCalls.push(input); return { data: { items: state.pending.filter((row) => row.request.type === input.type), nextCursor: null }, isLoading: false, isError: false, refetch: vi.fn() }; } },
  },
} }));
import { RequestsReview } from "../components/payments-admin/RequestsReview";

function row(id: number, type: "deposit" | "withdrawal", status: string, name: string) {
  return { request: { id, type, status, amount: "100.00", feeAmount: "0.00", reference: `REF-${id}` }, customer: { name, email: `${id}@example.test`, customerId: `C-${id}` } };
}

describe("payment review selection", () => {
  beforeEach(() => { state.selected = null; state.pending = []; state.selectedCalls.length = 0; state.listCalls.length = 0; });
  it("loads and highlights a specified request even outside the pending page, with both types fetched independently", () => {
    state.selected = row(313, "withdrawal", "pending", "Selected outside page");
    state.pending = [row(1, "deposit", "pending", "Deposit first"), row(2, "withdrawal", "pending", "Withdrawal first")];
    const html = renderToStaticMarkup(<RequestsReview selectedRequestId={313} />);
    expect(state.selectedCalls[0].input).toEqual({ requestId: 313 });
    expect(state.selectedCalls[0].options.enabled).toBe(true);
    expect(state.listCalls.map((call) => call.type)).toEqual(["deposit", "withdrawal"]);
    expect(html).toContain("الطلب المحدد");
    expect(html).toContain("Selected outside page");
    expect(html).toContain("Deposit first");
    expect(html).toContain("Withdrawal first");
    expect(html).not.toContain("تأكيد تنفيذ السحب"); // Selection is read-only; the decision dialog is never automatic.
  });
  it("does not duplicate a selected row that is already on the current page", () => {
    state.selected = row(2, "deposit", "pending", "Only one selected row");
    state.pending = [state.selected];
    const html = renderToStaticMarkup(<RequestsReview selectedRequestId={2} />);
    expect(html.match(/Only one selected row/g)).toHaveLength(1);
  });
  it("shows a finalized selected request without decision controls", () => {
    state.selected = row(4, "deposit", "approved", "Already reviewed");
    const html = renderToStaticMarkup(<RequestsReview selectedRequestId={4} />);
    expect(html).toContain("Already reviewed");
    expect(html).toContain("لم يعد معلقًا");
    expect(html).not.toContain("تأكيد اعتماد الإيداع");
    expect(html).not.toContain("اعتماد</span>");
  });
  it("does not query a selected request when there is none", () => {
    renderToStaticMarkup(<RequestsReview />);
    expect(state.selectedCalls[0].options.enabled).toBe(false);
  });
});
