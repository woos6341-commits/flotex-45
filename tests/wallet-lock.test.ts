import { describe, expect, it, vi } from "vitest";
import { withWalletLock } from "../server/db";

describe("wallet advisory lock", () => {
  it("never executes a financial action when the lock times out", async () => {
    const tx = { execute: vi.fn().mockResolvedValue([[{ acquired: 0 }], []]) };
    const action = vi.fn();
    await expect(withWalletLock(tx, 9, action)).rejects.toThrow("المحفظة مشغولة");
    expect(action).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("executes only after acquisition and releases the lock", async () => {
    const tx = { execute: vi.fn().mockResolvedValueOnce([[{ acquired: 1 }], []]).mockResolvedValueOnce([[{ released: 1 }], []]) };
    await expect(withWalletLock(tx, 9, async () => "done")).resolves.toBe("done");
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("releases an acquired lock if the action throws", async () => {
    const tx = { execute: vi.fn().mockResolvedValueOnce([[{ acquired: 1 }], []]).mockResolvedValueOnce([[{ released: 1 }], []]) };
    await expect(withWalletLock(tx, 9, async () => { throw new Error("test failure"); })).rejects.toThrow("test failure");
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
});
