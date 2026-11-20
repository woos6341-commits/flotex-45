import { describe, expect, it } from "vitest";
import {
  formatEgyptDateTime,
  isUiButtonId,
  isUiButtonVisible,
  isUiSurface,
  resolveUiButtonVisibility,
  UI_BUTTONS,
} from "../shared/ui-button-visibility";
import { HOME_QUICK_ACTIONS } from "../shared/home-dashboard";

const ORIGINAL_WALLET_ACTION_IDS = ["deposit", "transfer", "externalTransfers", "withdrawal", "savings", "transactions"];

describe("UI button visibility registry", () => {
  it("registers every original home service and wallet shortcut for independent administration", () => {
    expect(HOME_QUICK_ACTIONS).toHaveLength(9);
    expect(HOME_QUICK_ACTIONS.every((action) => isUiButtonId("home", action.id))).toBe(true);
    expect(ORIGINAL_WALLET_ACTION_IDS.every((id) => isUiButtonId("wallet", id))).toBe(true);
    expect(isUiButtonId("home", "externalTransfers")).toBe(true);
    expect(isUiButtonId("wallet", "externalTransfers")).toBe(true);
    expect(UI_BUTTONS.home.filter((button) => ["deposit", "withdrawal", "transfer", "savings"].includes(button.id))).toHaveLength(4);
  });

  it("allows only the two declared surfaces", () => {
    expect(isUiSurface("home")).toBe(true);
    expect(isUiSurface("wallet")).toBe(true);
    expect(isUiSurface("admin")).toBe(false);
  });

  it("uses a per-user show/hide override over the global default and inherits when requested", () => {
    expect(resolveUiButtonVisibility(false, "visible")).toBe(true);
    expect(resolveUiButtonVisibility(true, "hidden")).toBe(false);
    expect(resolveUiButtonVisibility(false, "inherit")).toBe(false);
    expect(resolveUiButtonVisibility(true, "inherit")).toBe(true);
  });

  it("leaves every original home service and wallet shortcut visible by default", () => {
    expect(HOME_QUICK_ACTIONS.filter((action) => isUiButtonVisible(undefined, "home", action.id))).toHaveLength(9);
    expect(ORIGINAL_WALLET_ACTION_IDS.filter((id) => isUiButtonVisible(undefined, "wallet", id))).toHaveLength(6);
    expect(isUiButtonVisible({ home: { deposit: { visible: false } } }, "home", "deposit")).toBe(false);
    expect(isUiButtonVisible({ home: {} }, "home", "savings")).toBe(true);
  });

  it("uses the requested Arabic empty-state phrase and formats persisted timestamps in Cairo time", () => {
    expect(formatEgyptDateTime(null)).toBe("لم يسجل أي نشاط بعد");
    const formatted = formatEgyptDateTime("2025-01-01T00:00:00.000Z");
    const expected = new Intl.DateTimeFormat("ar-EG", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date("2025-01-01T00:00:00.000Z"));
    expect(formatted).toBe(expected);
  });
});
