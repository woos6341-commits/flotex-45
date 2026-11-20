import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  hooks: [] as any[], cursor: 0, cache: undefined as any, reviewOptions: null as any,
  mutations: [] as any[], invalidate: vi.fn(async () => undefined),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState(initial: any) {
    const index = h.cursor++;
    if (!(index in h.hooks)) h.hooks[index] = typeof initial === "function" ? initial() : initial;
    return [h.hooks[index], (value: any) => { h.hooks[index] = typeof value === "function" ? value(h.hooks[index]) : value; }];
  },
  useRef(initial: any) { const index = h.cursor++; if (!(index in h.hooks)) h.hooks[index] = { current: initial }; return h.hooks[index]; },
  useEffect() {},
}));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Switch: "Switch", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 } }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-image", () => ({ Image: "Image" }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("@/components/atheer-ui", () => ({ ActionButton: "ActionButton", Card: "Card", EmptyState: "EmptyState", Pill: "Pill", formatMoney: (value: any) => String(value ?? "0") }));
vi.mock("@/lib/financial-feedback", () => ({ confirmFinancialAction: async () => true, showFinancialMessage: vi.fn() }));
vi.mock("@/lib/game-topup", () => ({ GAME_TOPUP_STATUS_TONE: {}, formatGameQuantity: (quantity: number, unit: string) => `${quantity} ${unit}`, resolveGameImageUrl: () => null }));
vi.mock("@/lib/trpc", () => {
  const mockMutation = () => ({ useMutation: () => ({ mutate: vi.fn() }) });
  return { trpc: {
    useUtils: () => ({ gameTopup: { adminRequests: { invalidate: h.invalidate, setData: (_key: any, fn: any) => { h.cache = fn(h.cache); } }, adminCatalog: { invalidate: h.invalidate }, catalog: { invalidate: h.invalidate }, overview: { invalidate: h.invalidate } }, admin: { recentOperations: { invalidate: h.invalidate } } }),
    gameTopup: {
      adminRequests: { useQuery: () => ({ data: h.cache, isLoading: false, isError: false }) },
      adminCatalog: { useQuery: () => ({ data: undefined, isLoading: false }) },
      review: { useMutation: (options: any) => { h.reviewOptions = options; return { mutate: (value: any) => h.mutations.push(value) }; } },
      saveGame: mockMutation(), savePackage: mockMutation(), deletePackage: mockMutation(), updateSettings: mockMutation(), addFunding: mockMutation(), uploadImage: mockMutation(), clearImage: mockMutation(),
    },
  } };
});

import { GameTopupAdmin } from "../components/control/GameTopupAdmin";

function render() { h.cursor = 0; return GameTopupAdmin(); }
function nodes(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function buttons(tree: any) { return nodes(tree).filter((node) => typeof node.props?.label === "string").map((node) => node.props.label); }
function mutationResult(status: string) {
  return { request: { ...h.cache.requests[0], status, statusLabel: status, userName: null, customerId: null, currencyLabel: null }, message: "ok" };
}

beforeEach(() => {
  h.hooks = []; h.cursor = 0; h.mutations = []; h.invalidate.mockClear();
  h.cache = { total: 1, requests: [{ id: 1, reference: "FAKE-1", status: "new", statusLabel: "جديد", kind: "topup", kindLabel: "شحن", gameName: "لعبة", userName: "عميل وهمي", customerId: "123", currencyLabel: "شدة", quantity: 60, subtotalAmount: "50.00", feeAmount: "0.00", totalAmount: "50.00", playerData: [], createdAt: new Date(), reviewedAt: null }] };
});

describe("game admin active request lifecycle (mocked query and mutation)", () => {
  it("keeps review, approval and processing visible with the right actions, then removes a completed item", async () => {
    let tree = render();
    const start = nodes(tree).find((node) => node.props?.label === "بدء المراجعة");
    expect(start).toBeTruthy();
    start.props.onPress();
    expect(h.mutations).toEqual([expect.objectContaining({ requestId: 1, status: "under_review" })]);
    await h.reviewOptions.onSuccess(mutationResult("under_review"));
    tree = render();
    expect(h.cache.requests[0]).toMatchObject({ status: "under_review", userName: "عميل وهمي", customerId: "123", currencyLabel: "شدة" });
    expect(buttons(tree)).toContain("اعتماد وخصم");
    expect(buttons(tree)).toContain("رفض");
    expect(buttons(tree)).not.toContain("بدء المراجعة");

    await h.reviewOptions.onSuccess(mutationResult("approved"));
    tree = render();
    expect(buttons(tree)).toContain("جارٍ التنفيذ");
    expect(buttons(tree)).toContain("إكمال الطلب");
    expect(buttons(tree)).not.toContain("اعتماد وخصم");

    await h.reviewOptions.onSuccess(mutationResult("processing"));
    tree = render();
    expect(buttons(tree)).toContain("إكمال الطلب");
    expect(buttons(tree)).not.toContain("جارٍ التنفيذ");
    await h.reviewOptions.onSuccess(mutationResult("completed"));
    expect(h.cache).toEqual({ total: 0, requests: [] });
    expect(buttons(render())).not.toContain("إكمال الطلب");
    expect(h.invalidate).toHaveBeenCalledTimes(16);
  });

  it("removes a rejected item from active tracking without permanently hiding its ID", async () => {
    render();
    const prior = h.cache.requests[0];
    await h.reviewOptions.onSuccess(mutationResult("rejected"));
    expect(h.cache.requests).toEqual([]);
    h.cache = { total: 1, requests: [{ ...prior, status: "under_review" }] };
    expect(buttons(render())).toContain("اعتماد وخصم");
  });
});
