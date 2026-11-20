import { describe, expect, it } from "vitest";
import { appRouter } from "../server/routers";
import { ADMIN_EMAIL } from "../shared/admin";
import { canvasHeight, defaultButtonLayout, isValidButtonLayout, LAYOUT_ACTIONS, moveButton, positionsOverlap } from "../shared/button-layout";
import { HOME_QUICK_ACTIONS } from "../shared/home-dashboard";

function caller(user: unknown) {
  return appRouter.createCaller({ user, req: {}, res: { setHeader() {} } } as any);
}
describe("button layout model", () => {
  it("includes all home and wallet shortcut routes and both support buttons", () => {
    expect(LAYOUT_ACTIONS.home).toHaveLength(10);
    expect(LAYOUT_ACTIONS.wallet).toHaveLength(7);
    expect(LAYOUT_ACTIONS.home.slice(0, 9)).toEqual(HOME_QUICK_ACTIONS);
    for (const surface of ["home", "wallet"] as const) {
      expect(LAYOUT_ACTIONS[surface].find((a) => a.id === "support")?.route).toBe("/support");
      expect(isValidButtonLayout(surface, defaultButtonLayout(surface))).toBe(true);
    }
  });
  it("inherits the old global order when initially opening the home editor", () => {
    const layout = defaultButtonLayout("home", ["savings", "withdrawal", "transfer", "deposit"]);
    expect(layout.positions.slice(0, 5).map((p) => p.id)).toEqual(["savings", "withdrawal", "externalTransfers", "transfer", "deposit"]);
  });
  it("allows free non-grid positions, clamps boundaries and rejects collisions", () => {
    const base = defaultButtonLayout("home");
    const next = moveButton(base, "deposit", 0.73, 1);
    expect(next.positions.find((p) => p.id === "deposit")).toEqual({ id: "deposit", x: 0.73, y: 1 });
    expect(isValidButtonLayout("home", next)).toBe(true);
    const clamped = moveButton(base, "deposit", -5, 9);
    expect(clamped.positions.find((p) => p.id === "deposit")).toEqual({ id: "deposit", x: 0, y: 1 });
    const collided = moveButton(base, "deposit", 0.5, 0);
    expect(isValidButtonLayout("home", collided)).toBe(false);
    expect(positionsOverlap("home", collided.positions[0], collided.positions[1])).toBe(true);
    expect(canvasHeight("home")).toBeGreaterThan(canvasHeight("wallet"));
  });
  it("rejects missing, duplicate, unknown, out-of-bounds and non-finite coordinates", () => {
    const base = defaultButtonLayout("wallet");
    expect(isValidButtonLayout("wallet", { version: 1, positions: base.positions.slice(1) })).toBe(false);
    expect(isValidButtonLayout("wallet", { version: 1, positions: base.positions.map((p, i) => i === 1 ? { ...p, id: base.positions[0].id } : p) })).toBe(false);
    expect(isValidButtonLayout("wallet", { version: 1, positions: base.positions.map((p, i) => i === 0 ? { ...p, id: "unknown" } : p) })).toBe(false);
    expect(isValidButtonLayout("wallet", { version: 1, positions: base.positions.map((p, i) => i === 0 ? { ...p, x: NaN } : p) })).toBe(false);
    expect(isValidButtonLayout("wallet", { version: 1, positions: base.positions.map((p, i) => i === 0 ? { ...p, y: 1.1 } : p) })).toBe(false);
  });
  it("denies save, reset and audit to guests and ordinary or unapproved admins", async () => {
    for (const user of [null, { id: 2, role: "user", email: "x@example.test" }, { id: 3, role: "admin", email: "not-the-admin@example.test" }, { id: 4, role: "user", email: ADMIN_EMAIL }]) {
      await expect(caller(user).admin.buttonLayout.save({ surface: "home", layout: defaultButtonLayout("home") })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(user).admin.buttonLayout.reset({ surface: "home" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(user).admin.buttonLayout.audit()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});
