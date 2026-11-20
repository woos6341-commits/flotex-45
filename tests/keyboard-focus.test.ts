import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeyboardFocusState, measureContainedInput, subscribeKeyboardFocus } from "../lib/keyboard-focus";

const native = vi.hoisted(() => ({
  focus: null as unknown,
  metrics: undefined as unknown,
  handlers: new Map<string, Set<(event: any) => void>>(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Dimensions: { get: () => ({ height: 844, width: 390 }) },
  TextInput: { State: { currentlyFocusedInput: () => native.focus } },
  Keyboard: {
    metrics: () => native.metrics,
    addListener: (name: string, callback: (event: any) => void) => {
      if (!native.handlers.has(name)) native.handlers.set(name, new Set());
      native.handlers.get(name)!.add(callback);
      return { remove: () => native.handlers.get(name)!.delete(callback) };
    },
  },
}));

const cleanups: (() => void)[] = [];
function subscribe(callback: ReturnType<typeof vi.fn>) {
  const cleanup = subscribeKeyboardFocus(callback);
  cleanups.push(cleanup);
  return cleanup;
}
function event(name: string, screenY = 480) {
  native.handlers.get(name)?.forEach((handler) => handler({ endCoordinates: { screenX: 0, screenY, width: 390, height: 300 } }));
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  native.focus = null;
  native.metrics = undefined;
  native.handlers.clear();
  vi.useRealTimers();
});

describe("shared native keyboard/focus observer", () => {
  it("captures current keyboard metrics when a modal mounts after keyboard opening", () => {
    native.metrics = { screenX: 0, screenY: 480, width: 390, height: 300 };
    const callback = vi.fn();
    subscribe(callback);
    expect(callback).toHaveBeenLastCalledWith({ keyboard: { x: 0, y: 480, width: 390, height: 300 }, input: null });
  });
  it("responds to opening and iOS frame changes with current input identity", () => {
    const input = { id: "amount" };
    const callback = vi.fn();
    subscribe(callback);
    native.focus = input;
    event("keyboardWillShow");
    expect(callback).toHaveBeenLastCalledWith({ keyboard: { x: 0, y: 480, width: 390, height: 300 }, input });
    event("keyboardWillChangeFrame", 420);
    expect(getKeyboardFocusState().keyboard?.y).toBe(420);
  });
  it("detects programmatic field changes without a second keyboard opening event", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    subscribe(callback);
    native.focus = { id: "first" };
    event("keyboardDidShow");
    callback.mockClear();
    const next = { id: "second" };
    native.focus = next;
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].input).toBe(next);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it("shares exactly one active-only fallback timer across all screens/modals", () => {
    vi.useFakeTimers();
    subscribe(vi.fn());
    subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
    event("keyboardDidShow");
    expect(vi.getTimerCount()).toBe(1);
    event("keyboardWillShow");
    expect(vi.getTimerCount()).toBe(1);
    event("keyboardDidHide");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears subscriptions and timers when the last screen unmounts", () => {
    vi.useFakeTimers();
    const stop = subscribe(vi.fn());
    event("keyboardDidShow");
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect([...native.handlers.values()].every((handlers) => !handlers.size)).toBe(true);
  });
  it("reports no keyboard on dismissal and stops observing focus", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    subscribe(callback);
    event("keyboardDidShow");
    native.focus = null;
    event("keyboardWillHide");
    expect(callback).toHaveBeenLastCalledWith({ keyboard: null, input: null });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("treats an offscreen iOS closing frame as hidden, not a second opening", () => {
    vi.useFakeTimers();
    subscribe(vi.fn());
    event("keyboardWillShow");
    event("keyboardWillChangeFrame", 844);
    expect(getKeyboardFocusState().keyboard).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("native scroll ownership/measurement", () => {
  it("measures the complete focused field only after ancestor validation", () => {
    const content = {};
    const input = { measureLayout: vi.fn((_ancestor, success) => success(10, 250, 300, 54)), measureInWindow: vi.fn((success) => success(40, 580, 300, 54)) };
    const measured = vi.fn();
    measureContainedInput(input as any, content as any, measured);
    expect(input.measureLayout.mock.calls[0][0]).toBe(content);
    expect(measured).toHaveBeenCalledWith({ x: 40, y: 580, width: 300, height: 54 });
  });
  it("does not scroll a screen behind a native modal", () => {
    const input = { measureLayout: vi.fn((_ancestor, _success, failure) => failure()), measureInWindow: vi.fn() };
    const measured = vi.fn();
    measureContainedInput(input as any, {} as any, measured);
    expect(input.measureInWindow).not.toHaveBeenCalled();
    expect(measured).not.toHaveBeenCalled();
  });
  it("safely ignores unmounted focused inputs and zero-sized measurements", () => {
    expect(() => measureContainedInput({ measureLayout: () => { throw new Error("unmounted"); } } as any, {} as any, vi.fn())).not.toThrow();
    const measured = vi.fn();
    measureContainedInput({ measureLayout: (_ancestor: any, success: any) => success(), measureInWindow: (success: any) => success(0, 0, 0, 0) } as any, {} as any, measured);
    expect(measured).not.toHaveBeenCalled();
  });
});
