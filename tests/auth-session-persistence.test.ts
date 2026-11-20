import { describe, expect, it } from "vitest";
import { resolveSessionUser } from "../shared/auth-session-resolution";

const stored = { id: 7, name: "عميل محفوظ" };
const fresh = { id: 7, name: "عميل محدث" };

describe("durable auth session resolution", () => {
  it("keeps the cached user while the server is unreachable", () => {
    expect(resolveSessionUser({ signedOut: false, serverSettled: false, serverUser: null, storedUser: stored })).toEqual(stored);
  });

  it("clears the cached user only after a successful null response", () => {
    expect(resolveSessionUser({ signedOut: false, serverSettled: true, serverUser: null, storedUser: stored })).toBeNull();
  });

  it("uses the fresh server identity when verification succeeds", () => {
    expect(resolveSessionUser({ signedOut: false, serverSettled: true, serverUser: fresh, storedUser: stored })).toEqual(fresh);
  });

  it("never restores a user after an explicit local sign-out", () => {
    expect(resolveSessionUser({ signedOut: true, serverSettled: false, serverUser: null, storedUser: stored })).toBeNull();
    expect(resolveSessionUser({ signedOut: true, serverSettled: true, serverUser: fresh, storedUser: stored })).toBeNull();
  });
});
