import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ hooks: [] as any[], cursor: 0, effects: [] as Array<() => void | (() => void)>, query: vi.fn(), create: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: any) { const i = h.cursor++; if (!(i in h.hooks)) h.hooks[i] = typeof initial === "function" ? initial() : initial; return [h.hooks[i], (value: any) => { h.hooks[i] = typeof value === "function" ? value(h.hooks[i]) : value; }]; },
  useRef(initial: any) { const i = h.cursor++; if (!(i in h.hooks)) h.hooks[i] = { current: initial }; return h.hooks[i]; },
  useCallback(callback: any) { return callback; },
  useEffect(callback: any) { h.effects.push(callback); },
}));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Modal: "Modal", Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View" }));
vi.mock("@/components/atheer-ui", () => ({ ActionButton: "ActionButton", Card: "Card", EmptyState: "EmptyState", Pill: "Pill" }));
vi.mock("@/components/DateOnlyField", () => ({ DateOnlyField: "DateOnlyField" }));
vi.mock("@/lib/manual-auth-client", () => ({ manualAuthClient: { adminCreatedAccounts: { listImmediate: { query: h.query }, createImmediate: { mutate: h.create } } } }));
vi.mock("@/hooks/use-ephemeral-mutation", () => ({ useEphemeralMutation: () => ({ isPending: false, mutateAsync: h.create }) }));
import { AdminImmediateAccounts } from "../components/control/AdminImmediateAccounts";

function render() { h.cursor = 0; h.effects = []; return AdminImmediateAccounts(); }
function nodes(node: any): any[] { if (!node || typeof node !== "object") return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
function input(tree: any, label: string) { return nodes(tree).find(item => item.props?.accessibilityLabel === label); }

beforeEach(() => { vi.useFakeTimers(); h.hooks = []; h.cursor = 0; h.effects = []; h.query.mockReset().mockResolvedValue([]); h.create.mockReset().mockResolvedValue({ id: "id", customerId: "0000000001" }); });
afterEach(() => vi.useRealTimers());

describe("admin immediate-account form", () => {
  it("includes every required field and hides both password inputs", () => {
    const tree = render();
    for (const label of ["الاسم بالكامل", "البريد الإلكتروني", "رقم الهاتف", "اختيار المحافظة", "كلمة المرور المبدئية", "تأكيد كلمة المرور المبدئية"]) expect(input(tree, label)).toBeTruthy();
    expect(nodes(tree).some(item => item.type === "DateOnlyField")).toBe(true);
    expect(input(tree, "كلمة المرور المبدئية").props.secureTextEntry).toBe(true);
    expect(input(tree, "تأكيد كلمة المرور المبدئية").props.secureTextEntry).toBe(true);
  });
  it("refreshes the list periodically and clears its timer on unmount", async () => {
    render(); const cleanup = h.effects[0]();
    await Promise.resolve(); expect(h.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(h.query).toHaveBeenCalledTimes(2);
    if (typeof cleanup === "function") cleanup();
    await vi.advanceTimersByTimeAsync(20_000); expect(h.query).toHaveBeenCalledTimes(2);
  });
});
