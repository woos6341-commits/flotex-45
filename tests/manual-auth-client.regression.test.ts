import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  gate: null as Promise<void> | null,
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => mocks.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { if (mocks.gate) await mocks.gate; mocks.store.set(key, value); },
  deleteItemAsync: async (key: string) => { mocks.store.delete(key); },
}));
vi.mock("@/constants/api", () => ({ SESSION_TOKEN_KEY: "session", USER_INFO_KEY: "profile" }));
vi.mock("@/lib/trpc", () => ({ createTRPCClient: () => ({}), trpc: { auth: { me: {} } } }));
vi.mock("@trpc/react-query", () => ({ getQueryKey: () => ["auth", "me"] }));
import * as Auth from "../lib/_core/auth";
import { assertManualSession, saveManualSession } from "../lib/manual-auth-client";
import { authSessionState } from "../shared/auth-session-state";

const session = { app_session_id: "validated-session", user: {
  id: 71, openId: "manual:actual-server-id", customerId: "0000000071", email: "actual@example.com",
  name: "Actual User", lastSignedIn: new Date("2026-11-10T10:00:00Z"), loginMethod: "password", role: "user" as const,
  accountFrozen: true,
} };
beforeEach(async () => {
  mocks.gate = null;
  await Auth.removeSessionToken(); await Auth.clearUserInfo(); mocks.store.clear();
  authSessionState.signOut();
});

describe("real session hydration without stale account data", () => {
  it("immediately publishes the returned account and clears previous-account query and mutation caches", async () => {
    const client = new QueryClient();
    client.setQueryData(["portfolio"], { userId: 2, balance: 999 });
    const old = client.getMutationCache().build(client, {});
    old.state.data = { stale: true };
    await saveManualSession(session, client);
    expect(client.getQueryData(["auth", "me"])).toEqual(session.user);
    expect(client.getQueryData(["portfolio"])).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(authSessionState.getSnapshot().signedOut).toBe(false);
    expect(mocks.store.get("session")).toBe("validated-session");
  });
  it("keeps the verified account and token on a transient profile refetch failure", async () => {
    const client = new QueryClient();
    await saveManualSession(session, client);
    await expect(client.fetchQuery({ queryKey: ["auth", "me"], retry: false, queryFn: async () => { throw new Error("503 temporary"); } })).rejects.toThrow("503");
    expect(client.getQueryData(["auth", "me"])).toEqual(session.user);
    expect(authSessionState.getSnapshot().signedOut).toBe(false);
    expect(mocks.store.get("session")).toBe("validated-session");
  });
  it("does not persist secrets/hashes even if accidentally added to the response object", async () => {
    await Auth.setUserInfo({ ...session.user, password: "PRIVATE-PASSWORD", securityPin: "0042", securityPinHash: "PRIVATE-HASH" } as Auth.User);
    const stored = mocks.store.get("profile")!;
    expect(stored).not.toContain("PRIVATE"); expect(stored).not.toContain("0042");
    expect(JSON.parse(stored).customerId).toBe("0000000071");
  });
  it("never accepts another account or a missing real account number", () => {
    expect(() => assertManualSession(session, "other@example.com")).toThrow("لا تطابق");
    expect(() => assertManualSession({ ...session, user: { ...session.user, customerId: "" } })).toThrow();
    expect(() => assertManualSession({ ...session, app_session_id: "" })).toThrow();
  });
  it("cannot resurrect a session when logout overtakes a SecureStore write", async () => {
    let release!: () => void;
    mocks.gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new QueryClient();
    const result = saveManualSession(session, client);
    // Let the transaction reach the delayed native token write.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    authSessionState.signOut();
    const cleanup = Promise.all([Auth.removeSessionToken(), Auth.clearUserInfo()]);
    release();
    await expect(result).rejects.toThrow("تغيّرت جلسة الحساب");
    await cleanup;
    expect(mocks.store.has("session")).toBe(false);
    expect(mocks.store.has("profile")).toBe(false);
    expect(client.getQueryData(["auth", "me"])).toBeUndefined();
  });
});
