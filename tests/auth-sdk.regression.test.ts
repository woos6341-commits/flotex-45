import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { HttpError } from "../shared/_core/errors";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getUser: vi.fn(), upsert: vi.fn(), revoked: vi.fn() }));
vi.mock("../server/db", () => ({ getDb: mocks.getDb, getUserByOpenId: mocks.getUser, upsertUser: mocks.upsert }));
vi.mock("../server/session-management", () => ({ isPresentedSessionRevoked: mocks.revoked }));
vi.mock("../server/_core/env", () => ({ ENV: { appId: "test-project", cookieSecret: "deterministic-test-key-never-production", oAuthServerUrl: "https://invalid.example" } }));
vi.mock("../server/_core/cookies", () => ({ currentSessionCookie: () => null }));
import { sdk } from "../server/_core/sdk";

const user = { id: 41, openId: "manual:test", customerId: "0000000041", name: "Test", role: "user" };
beforeEach(() => {
  vi.clearAllMocks(); mocks.getDb.mockResolvedValue({}); mocks.getUser.mockResolvedValue(user); mocks.revoked.mockResolvedValue(false);
});
async function request() {
  const token = await sdk.createSessionToken(user.openId);
  return { headers: { authorization: `Bearer ${token}` } } as Request;
}

describe("SDK session checks remain read-only and distinguish availability", () => {
  it("issues distinct session tokens for two immediate logins of the same account", async () => {
    const first = await sdk.createSessionToken(user.openId);
    const second = await sdk.createSessionToken(user.openId);
    expect(second).not.toBe(first);
  });
  it("returns a real authenticated user without an unrelated profile upsert", async () => {
    await expect(sdk.authenticateRequest(await request())).resolves.toEqual(user);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("treats a transient DB failure or missing database as 503, never missing user", async () => {
    mocks.getUser.mockRejectedValueOnce(new Error("connection reset"));
    await expect(sdk.authenticateRequest(await request())).rejects.toMatchObject({ statusCode: 503 });
    mocks.getDb.mockResolvedValueOnce(null);
    await expect(sdk.authenticateRequest(await request())).rejects.toMatchObject({ statusCode: 503 });
  });
  it("treats a failed revocation lookup as unavailable rather than authenticated or logged out", async () => {
    mocks.revoked.mockRejectedValueOnce(new Error("connection lost"));
    await expect(sdk.authenticateRequest(await request())).rejects.toMatchObject({ statusCode: 503 });
  });
  it("rejects genuinely missing, invalid and revoked sessions", async () => {
    await expect(sdk.authenticateRequest({ headers: {} } as Request)).rejects.toBeInstanceOf(HttpError);
    await expect(sdk.authenticateRequest({ headers: { authorization: "Bearer invalid" } } as Request)).rejects.toMatchObject({ statusCode: 403 });
    mocks.revoked.mockResolvedValueOnce(true);
    await expect(sdk.authenticateRequest(await request())).rejects.toMatchObject({ statusCode: 403 });
  });
});
