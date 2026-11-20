import React from "react";
import { describe, expect, it, vi } from "vitest";
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };
vi.mock("react-native", async () => {
  const React = await import("react");
  const wrap = (tag: string) => ({ children }: any) => React.createElement(tag, null, children);
  return { ActivityIndicator: wrap("div"), Pressable: wrap("button"), Text: wrap("span"), View: wrap("div") };
});
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("@/components/atheer-ui", async () => {
  const React = await import("react");
  return { Card: ({ children }: any) => React.createElement("section", null, children), Pill: ({ children }: any) => React.createElement("span", null, children), EmptyState: ({ title, text }: any) => React.createElement("div", null, title, text), formatMoney: (value: unknown) => String(value) };
});
import { OperationsSummary } from "../components/control/OperationsSummary";

describe("admin recent operations error state", () => {
  it("does not present failed data as an empty queue and exposes an explicit retry", () => {
    const html = renderToStaticMarkup(<OperationsSummary operations={{ isLoading: false, isError: true, isFetching: false, data: undefined, refetch: vi.fn() }} onOpen={vi.fn()} />);
    expect(html).toContain("تعذر تحميل أحدث العمليات");
    expect(html).toContain("إعادة المحاولة");
    expect(html).not.toContain("لا توجد طلبات حديثة");
  });
});
