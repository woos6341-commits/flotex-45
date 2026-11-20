import { beforeEach, describe, expect, it, vi } from "vitest";
const revoke = vi.hoisted(() => vi.fn());
vi.mock("../server/revoke-presented-session", () => ({ revokePresentedSession: revoke }));
import { appRouter } from "../server/routers";
import type { TrpcContext } from "../server/_core/context";
import { getSessionCookieName } from "../server/_core/cookies";

type CookieCall = {
  name: string;
  options: Record<string, unknown>;
};

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext; clearedCookies: CookieCall[] } {
  const clearedCookies: CookieCall[] = [];

  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    customerId: "0000000001",
    email: "sample@example.com",
    emailNormalized: "sample@example.com",
    givenName: null, fatherName: null, birthDate: null, nationalIdCiphertext: null, nationalIdLast4: null, nationalIdFingerprint: null, lastOpenedAt: null, appVersion: null, appBuildNumber: null, securityPinHash: null, securityPinUpdatedAt: null, phoneNumber: null, phoneVerifiedAt: null, profileCompletedAt: null,
    phoneNormalized: null,
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    status: "active",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };

  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  beforeEach(() => { revoke.mockReset(); revoke.mockResolvedValue(undefined); });
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(getSessionCookieName(ctx.req));
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    });
  });
  it("clears the cookie but does not falsely report successful revocation when DB fails", async () => {
    revoke.mockRejectedValueOnce(new Error("DB unavailable"));
    const { ctx, clearedCookies } = createAuthContext();
    await expect(appRouter.createCaller(ctx).auth.logout()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(clearedCookies).toHaveLength(1);
  });
});
