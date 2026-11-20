import { afterEach, describe, expect, it, vi } from "vitest";
import { registrationReceiptText, startRegistrationProgress, type RegistrationProgress } from "../shared/registration-progress";

afterEach(() => vi.useRealTimers());
describe("truthful registration presentation", () => {
  it("stops the spinner at 3000ms while leaving the real request unresolved", async () => {
    vi.useFakeTimers();
    const states: RegistrationProgress[] = [];
    let complete!: (value: string) => void;
    const request = new Promise<string>((resolve) => { complete = resolve; });
    const stop = startRegistrationProgress((state) => states.push(state));
    let success = false;
    const settled = request.then(() => { success = true; stop(); });
    vi.advanceTimersByTime(2999);
    expect(states).toEqual(["registering"]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual(["registering", "waiting"]);
    expect(success).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(success).toBe(false);
    complete("actual-server-success"); await settled;
    expect(states).toEqual(["registering", "waiting", "idle"]);
  });
  it("clears the timer on fast real completion or dismissal", () => {
    vi.useFakeTimers();
    const states: RegistrationProgress[] = [];
    const stop = startRegistrationProgress((state) => states.push(state));
    vi.advanceTimersByTime(100); stop(); vi.advanceTimersByTime(10_000);
    expect(states).toEqual(["registering", "idle"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the shared receipt formatter free of password and PIN values", () => {
    const receipt = { customerId: "0098765432", password: "PRIVATE-PASSWORD", securityPin: "0042" };
    expect(registrationReceiptText(receipt)).toBe("رقم الحساب: 0098765432");
    expect(registrationReceiptText(receipt)).not.toContain("PRIVATE-PASSWORD");
    expect(registrationReceiptText(receipt)).not.toContain("0042");
  });
});
