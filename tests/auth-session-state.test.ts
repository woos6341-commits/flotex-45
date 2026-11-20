import { describe, expect, it, vi } from "vitest";
import { createAuthSessionState } from "../shared/auth-session-state";
import { performLogout } from "../shared/logout-lifecycle";
import { isPublicUnauthenticatedRoute, PROTECTED_ROOT_ROUTES, shouldRestoreVerificationRoute } from "../shared/auth-routing";
import { readdirSync } from "node:fs";
import { shouldBlockForAuthState } from "../shared/auth-session-resolution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shared auth transitions", () => {
  it("notifies every mounted observer on native-compatible transitions", () => {
    const state = createAuthSessionState();
    const home = vi.fn(); const wallet = vi.fn();
    state.subscribe(home); state.subscribe(wallet);
    state.signIn(); state.signOut();
    expect(home).toHaveBeenCalledTimes(2);
    expect(wallet).toHaveBeenCalledTimes(2);
    expect(state.getSnapshot().signedOut).toBe(true);
  });
  it("bounds session restore waiting without clearing a stored session", () => {
    expect(shouldBlockForAuthState({ sessionReady: false, hasSessionToken: false, hasCachedUser: false, serverQueryLoading: false, serverVerificationTimedOut: false })).toBe(true);
    expect(shouldBlockForAuthState({ sessionReady: true, hasSessionToken: false, hasCachedUser: false, serverQueryLoading: false, serverVerificationTimedOut: false })).toBe(false);
    expect(shouldBlockForAuthState({ sessionReady: true, hasSessionToken: true, hasCachedUser: false, serverQueryLoading: true, serverVerificationTimedOut: false })).toBe(true);
    expect(shouldBlockForAuthState({ sessionReady: true, hasSessionToken: true, hasCachedUser: false, serverQueryLoading: true, serverVerificationTimedOut: true })).toBe(false);
    expect(shouldBlockForAuthState({ sessionReady: true, hasSessionToken: true, hasCachedUser: true, serverQueryLoading: true, serverVerificationTimedOut: false })).toBe(false);
  });
  it("rejects a late login or profile response after logout", () => {
    const state = createAuthSessionState();
    const before = state.getSnapshot().generation;
    state.signOut();
    expect(() => state.assertCurrent(before)).toThrow();
  });
  it("clears only the ephemeral receipt flag and keeps secrets outside session state", () => {
    const state = createAuthSessionState();
    state.setRegistrationReceiptActive(true);
    state.signIn();
    expect(state.getSnapshot().registrationReceiptActive).toBe(true);
    state.signOut();
    expect(state.getSnapshot()).toEqual({ generation: 2, signedOut: true, registrationReceiptActive: false });
  });
});

describe("logout critical path", () => {
  it("hides protected data synchronously before unresolved storage and revocation", async () => {
    const server = deferred<void>(); const local = deferred<void>();
    const order: string[] = [];
    const finished = performLogout({
      captureToken: () => { order.push("capture"); return Promise.resolve("real-presented-token"); },
      signOut: () => { order.push("signed-out"); },
      cancelQueries: async () => { order.push("cancel"); },
      clearCache: () => { order.push("clear-account-wallet-cache"); },
      clearLocal: () => { order.push("clear-local"); return local.promise; },
      revoke: (token) => { expect(token).toBe("real-presented-token"); order.push("revoke"); return server.promise; },
    });
    expect(order).toEqual(["capture", "signed-out", "cancel", "clear-account-wallet-cache", "clear-local"]);
    await Promise.resolve();
    expect(order.at(-1)).toBe("revoke");
    local.resolve(); server.resolve(); await finished;
  });
  it("never reports server revocation success when the network fails", async () => {
    const finished = performLogout({ captureToken: async () => "token", signOut: vi.fn(), cancelQueries: async () => undefined,
      clearCache: vi.fn(), clearLocal: async () => undefined, revoke: async () => { throw new Error("offline"); } });
    await expect(finished).rejects.toThrow("تعذر تأكيد إبطال الجلسة على الخادم");
  });
});

describe("protected history and camera recovery", () => {
  it("registers every non-public root screen under a protected navigator", () => {
    const files = readdirSync(new URL("../app/", import.meta.url)).filter((name) => name.endsWith(".tsx"));
    const publicFiles = new Set(["_layout.tsx", "index.tsx", "register.tsx", "forgot-password.tsx", "admin.tsx", "control.tsx", "support-portal.tsx", "guest-support.tsx"]);
    expect(files.filter((name) => !publicFiles.has(name)).map((name) => name.slice(0, -4)).sort())
      .toEqual(PROTECTED_ROOT_ROUTES.filter((name) => !name.includes("/")).slice().sort());
  });
  it("keeps deleted-account support public and sensitive account screens protected", () => {
    expect(isPublicUnauthenticatedRoute(["support-portal"])).toBe(true);
    expect(isPublicUnauthenticatedRoute(["(tabs)", "profile"])).toBe(true);
    expect(isPublicUnauthenticatedRoute(["(tabs)", "wallet"])).toBe(false);
    expect(PROTECTED_ROOT_ROUTES).toContain("delete-account");
    expect(PROTECTED_ROOT_ROUTES).toContain("change-password");
  });
  it("restores a camera route only from the authenticated entry and never repeats the destination", () => {
    expect(shouldRestoreVerificationRoute(["(tabs)", "index"], "/account-verification")).toBe(true);
    expect(shouldRestoreVerificationRoute(["account-verification"], "/account-verification")).toBe(false);
    expect(shouldRestoreVerificationRoute(["change-phone"], "/change-phone")).toBe(false);
    expect(shouldRestoreVerificationRoute(["(tabs)", "wallet"], "/change-phone")).toBe(false);
  });
});
