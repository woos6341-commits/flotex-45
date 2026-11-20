import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: React.ReactElement) => string };
const state = vi.hoisted(() => ({ calls: [] as any[], ticketsError: false }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const wrap = (tag: string) => ({ children }: any) => React.createElement(tag, null, children);
  return { View: wrap("div"), Text: wrap("span"), Pressable: wrap("button"), TextInput: () => React.createElement("textarea"), ActivityIndicator: wrap("div") };
});
vi.mock("@/components/atheer-ui", async () => {
  const React = await import("react");
  return { Card: ({ children }: any) => React.createElement("div", null, children), Pill: ({ children }: any) => React.createElement("span", null, children), ActionButton: ({ label }: any) => React.createElement("button", null, label) };
});
vi.mock("@/components/guest-support/GuestSupportAttachments", () => ({
  useGuestSupportAttachment: () => ({ attachment: null, setAttachment() {}, setAttachmentError() {} }),
  GuestSupportAttachmentPicker: () => null, GuestSupportAttachmentView: () => null,
}));
vi.mock("@/lib/trpc", () => {
  const tickets = [{ ticket: { id: 102, ticketCode: "FLX-TEST-102", displayName: "زائر مستقل", status: "new", createdAt: new Date("2026-01-01") }, lastMessage: null, unread: 1 }];
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false, reset: vi.fn(), error: null });
  return { trpc: { admin: {
    guestSupportTickets: { useQuery: () => ({ data: state.ticketsError ? undefined : tickets, isLoading: false, isError: state.ticketsError, isFetching: false, error: new Error("synthetic database error"), refetch: vi.fn() }) },
    guestSupportMessages: { useQuery: (input: unknown, options: unknown) => { state.calls.push({ input, options }); return { data: [{ id: 1, senderRole: "guest", body: "الرسالة المحددة", attachment: null, readAt: null, createdAt: new Date("2026-01-01") }], isLoading: false, isError: false, refetch: vi.fn() }; } },
    replyGuestSupport: { useMutation: mutation }, updateGuestSupportStatus: { useMutation: mutation },
  } } };
});
vi.mock("@/lib/guest-support-client", () => ({ GUEST_STATUS_LABELS: { new: "جديدة", pending_reply: "قيد المراجعة", replied: "تم الرد", closed: "مغلقة" }, newGuestOperationId: () => "test_operation_12345" }));
import { GuestSupportAdmin } from "../components/guest-support/GuestSupportAdmin";

describe("guest support admin direct selection", () => {
  beforeEach(() => { state.calls.length = 0; state.ticketsError = false; });
  it("opens the given guest ticket id and renders its messages without a user id", () => {
    const html = renderToStaticMarkup(<GuestSupportAdmin initialTicketId={102} />);
    expect(state.calls[0].input).toEqual({ ticketId: 102 });
    expect(state.calls[0].options.enabled).toBe(true);
    expect(html).toContain("الرسالة المحددة");
    expect(html).toContain("FLX-TEST-102");
    expect(html).toContain("الرد العادي لا يغلق المحادثة");
  });
  it("does not query ticket zero if nothing was selected", () => {
    renderToStaticMarkup(<GuestSupportAdmin />);
    expect(state.calls[0].options.enabled).toBe(false);
  });
  it("does not report zero conversations when the inbox API fails and offers retry", () => {
    state.ticketsError = true;
    const html = renderToStaticMarkup(<GuestSupportAdmin />);
    expect(html).toContain("العدد غير متاح");
    expect(html).not.toContain("0 محادثة");
    expect(html).toContain("لا يعني ذلك عدم وجود محادثات");
    expect(html).toContain("إعادة المحاولة");
  });
});
