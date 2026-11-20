import { describe, expect, it } from "vitest";
import { createFinancialGate } from "../server/_core/financial-gate";

describe("financial transaction concurrency gate", () => {
  it("bounds concurrent work while allowing queued work to proceed", async () => {
    const gate = createFinancialGate(2, 20, 1000);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, (_, i) => gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return i;
    })));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("releases a permit after failure and rejects excess work", async () => {
    const gate = createFinancialGate(1, 0, 1000);
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    release();
    await first;
    await expect(gate.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });
});
