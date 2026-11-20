import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { ForbiddenError } from "../shared/_core/errors";
import { authenticationUnavailable } from "../server/_core/auth-errors";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), revoke: vi.fn(), unregister: vi.fn() }));
vi.mock("../server/_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticate } }));
vi.mock("../server/revoke-presented-session", () => ({ revokePresentedSession: mocks.revoke }));
vi.mock("../server/manual-auth", () => ({ toPublicAuthUser: (user: unknown) => user }));
vi.mock("../server/push", () => ({ unregisterPushToken: mocks.unregister }));
vi.mock("../server/session-management", () => ({ requestSessionToken: () => "presented-token" }));
vi.mock("../server/_core/cookies", () => ({ getSessionCookieName: () => "test-session", getSessionCookieOptions: () => ({ path: "/", secure: true, sameSite: "none" }) }));
import { registerManualAuthRoutes } from "../server/_core/manual-auth-routes";
import { createContext } from "../server/_core/context";

const user = { id: 17, customerId: "0000000017" };
beforeEach(() => { vi.clearAllMocks(); mocks.authenticate.mockResolvedValue(user); mocks.revoke.mockResolvedValue(undefined); });
function setup() {
  const routes = new Map<string, (req: Request, res: Response) => Promise<unknown>>();
  registerManualAuthRoutes({ get: (path: string, handler: any) => routes.set(`GET ${path}`, handler), post: (path: string, handler: any) => routes.set(`POST ${path}`, handler) } as unknown as Express);
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), clearCookie: vi.fn() };
  res.status.mockReturnValue(res);
  return { routes, res, req: { headers: {}, body: {} } as Request };
}

describe("availability is not logout", () => {
  it("REST me returns 503 without user:null for a temporary failure", async () => {
    mocks.authenticate.mockRejectedValueOnce(authenticationUnavailable());
    const { routes, res, req } = setup(); await routes.get("GET /api/auth/me")!(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty("user");
  });
  it("REST me returns 401 and null only for invalid/revoked credentials", async () => {
    mocks.authenticate.mockRejectedValueOnce(ForbiddenError("revoked"));
    const { routes, res, req } = setup(); await routes.get("GET /api/auth/me")!(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401); expect(res.json).toHaveBeenCalledWith({ error: "Not authenticated", user: null });
  });
  it("tRPC propagates temporary errors so React Query retains the verified account", async () => {
    mocks.authenticate.mockRejectedValueOnce(authenticationUnavailable());
    const { req, res } = setup();
    await expect(createContext({ req, res: res as unknown as Response, info: {} } as Parameters<typeof createContext>[0]))
      .rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
  it("tRPC treats genuinely invalid credentials as public guest", async () => {
    mocks.authenticate.mockRejectedValueOnce(ForbiddenError("invalid"));
    const { req, res } = setup();
    await expect(createContext({ req, res: res as unknown as Response, info: {} } as Parameters<typeof createContext>[0]))
      .resolves.toMatchObject({ user: null });
  });
  it("logout revokes the exact bearer token and always clears the session cookie", async () => {
    const { routes, res, req } = setup(); await routes.get("POST /api/auth/logout")!(req, res as unknown as Response);
    expect(mocks.revoke).toHaveBeenCalledWith(17, "presented-token");
    expect(res.clearCookie).toHaveBeenCalledWith("test-session", expect.objectContaining({ maxAge: -1 }));
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
  it("logout never fakes successful revocation on DB failure", async () => {
    mocks.revoke.mockRejectedValueOnce(new Error("DB offline"));
    const { routes, res, req } = setup(); await routes.get("POST /api/auth/logout")!(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(503); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(res.clearCookie).toHaveBeenCalled();
  });
});
