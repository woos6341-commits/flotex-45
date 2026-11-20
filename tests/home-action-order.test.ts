import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_ACTION_ORDER,
  isValidHomeActionOrder,
  normalizeHomeActionOrder,
  resolveEffectiveHomeActionOrder,
  reorderHomeQuickActions,
} from "../shared/home-action-order";
import { HOME_QUICK_ACTIONS } from "../shared/home-dashboard";

const ORIGINAL_HOME_ACTION_IDS = [
  "deposit",
  "transfer",
  "externalTransfers",
  "withdrawal",
  "savings",
  "gameTopup",
  "coin",
  "transactions",
  "paymentMethods",
];

describe("home action order", () => {
  it("accepts exactly the four IDs once in any order", () => {
    expect(isValidHomeActionOrder(["savings", "transfer", "withdrawal", "deposit"])).toBe(true);
    expect(isValidHomeActionOrder(["deposit", "deposit", "transfer", "savings"])).toBe(false);
    expect(isValidHomeActionOrder(["deposit", "withdrawal", "transfer"])).toBe(false);
    expect(isValidHomeActionOrder(["deposit", "withdrawal", "transfer", "unknown"])).toBe(false);
    expect(isValidHomeActionOrder({ order: [...DEFAULT_HOME_ACTION_ORDER] })).toBe(false);
  });

  it("returns a safe default for absent or malformed persisted values", () => {
    expect(normalizeHomeActionOrder(null)).toEqual(DEFAULT_HOME_ACTION_ORDER);
    expect(normalizeHomeActionOrder(["deposit", "deposit", "withdrawal", "savings"])).toEqual(DEFAULT_HOME_ACTION_ORDER);
    expect(normalizeHomeActionOrder(["savings", "transfer", "withdrawal", "deposit"])).toEqual(["savings", "transfer", "withdrawal", "deposit"]);
  });

  it("uses a personal order without mutating the global order and inherits safely when absent", () => {
    const global = ["deposit", "transfer", "withdrawal", "savings"] as const;
    const personal = ["savings", "withdrawal", "transfer", "deposit"] as const;
    expect(resolveEffectiveHomeActionOrder(personal, global)).toEqual(personal);
    expect(resolveEffectiveHomeActionOrder(null, global)).toEqual(global);
    expect(resolveEffectiveHomeActionOrder(["deposit", "deposit"], global)).toEqual(global);
    expect(global).toEqual(["deposit", "transfer", "withdrawal", "savings"]);
  });

  it("preserves all nine original services and their positions by default", () => {
    expect(reorderHomeQuickActions(HOME_QUICK_ACTIONS, null).map((action) => action.id)).toEqual(ORIGINAL_HOME_ACTION_IDS);
  });

  it("reorders only the four managed services while retaining the other five services", () => {
    const ordered = reorderHomeQuickActions(HOME_QUICK_ACTIONS, ["savings", "withdrawal", "transfer", "deposit"]);
    expect(ordered.map((action) => action.id)).toEqual([
      "savings",
      "withdrawal",
      "externalTransfers",
      "transfer",
      "deposit",
      "gameTopup",
      "coin",
      "transactions",
      "paymentMethods",
    ]);
    expect(ordered).toHaveLength(HOME_QUICK_ACTIONS.length);
  });
});
