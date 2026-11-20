import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { appSettings } from "../drizzle/schema";
import {
  authenticateSavingsHeartbeat,
  createExternalSavingsAutoPayoutHandler,
  createSavingsCronSignature,
  createSavingsAutoPayoutHandler,
  registerSavingsAutoPayoutHeartbeat,
  SAVINGS_AUTO_PAYOUT_JOB_NAME,
  SAVINGS_AUTO_PAYOUT_PATH,
  SAVINGS_EXTERNAL_AUTO_PAYOUT_PATH,
} from "../server/savings-heartbeat";

const secret = "isolated-heartbeat-test-secret-with-enough-bytes";
const projectId = "project-test";
const taskUid = "T_test_savings_heartbeat";

async function signedCookie(claimOverrides: Record<string, unknown> = {}, signingSecret = secret, lifetime = "2h") {
  const token = await new SignJWT({
    appId: projectId,
    openId: "cron_test_identity",
    name: SAVINGS_AUTO_PAYOUT_JOB_NAME,
    ...claimOverrides,
  }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(lifetime).sign(new TextEncoder().encode(signingSecret));
  return `session=unrelated; app_session_id=${token}`;
}

function fakeResponse(identity: Record<string, unknown>, ok = true) {
  return { ok, json: async () => identity } as Response;
}

function fakeFetcher(identity: Record<string, unknown>) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => fakeResponse(identity));
}

describe("authenticated savings Heartbeat", () => {
  it("validates the platform JWT and resolves the exact project task identity", async () => {
    const cookie = await signedCookie();
    const fetcher = fakeFetcher({ openId: "cron_test_identity", projectId, name: SAVINGS_AUTO_PAYOUT_JOB_NAME, taskUid });
    const identity = await authenticateSavingsHeartbeat(cookie, {
      jwtSecret: secret,
      projectId,
      oauthApiUrl: "https://oauth.example.test/",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(identity.taskUid).toBe(taskUid);
    expect(fetcher).toHaveBeenCalledWith("https://oauth.example.test/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ jwt_token: cookie.split("app_session_id=")[1], project_id: projectId });
  });

  it("rejects missing tickets, invalid signatures, another project, and another job name", async () => {
    const fetcher = fakeFetcher({ openId: "cron_test_identity", projectId, name: SAVINGS_AUTO_PAYOUT_JOB_NAME, taskUid });
    await expect(authenticateSavingsHeartbeat(undefined, { jwtSecret: secret, projectId, oauthApiUrl: "https://oauth.example.test", fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ statusCode: 401 });
    await expect(authenticateSavingsHeartbeat(await signedCookie(), { jwtSecret: secret + "wrong", projectId, oauthApiUrl: "https://oauth.example.test", fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ statusCode: 401 });
    await expect(authenticateSavingsHeartbeat(await signedCookie({ appId: "other-project" }), { jwtSecret: secret, projectId, oauthApiUrl: "https://oauth.example.test", fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ statusCode: 403 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(authenticateSavingsHeartbeat(await signedCookie({ name: "other-job" }), { jwtSecret: secret, projectId, oauthApiUrl: "https://oauth.example.test", fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ statusCode: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(authenticateSavingsHeartbeat(await signedCookie({}, secret, "3h"), { jwtSecret: secret, projectId, oauthApiUrl: "https://oauth.example.test", fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ statusCode: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a resolved task identity that does not match the signed ticket", async () => {
    const fetcher = fakeFetcher({ openId: "other-cron", projectId, name: SAVINGS_AUTO_PAYOUT_JOB_NAME, taskUid });
    await expect(authenticateSavingsHeartbeat(await signedCookie(), {
      jwtSecret: secret,
      projectId,
      oauthApiUrl: "https://oauth.example.test",
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("runs no financial sweep unless the resolved task UID matches stored configuration", async () => {
    const registeredRoutes: Record<string, any> = {};
    const app = { post: (path: string, handler: any) => { registeredRoutes[path] = handler; } } as any;
    const runSweep = vi.fn(async () => ({ processed: 0, scanned: 0, blocked: 0, failed: 0, skipped: 0 }));
    let configuredTaskUid = "another-task";
    const db = {
      select: () => {
        const builder: any = {
          from: () => builder,
          where: (condition: any) => { expect(condition).toBeDefined(); return builder; },
          limit: async () => [{ value: configuredTaskUid }],
        };
        return builder;
      },
      insert: vi.fn(),
      update: vi.fn(),
    };
    const authenticate = vi.fn(async () => ({ openId: "cron_test_identity", projectId, name: SAVINGS_AUTO_PAYOUT_JOB_NAME, taskUid }));
    // Register through the public API using a tiny Express-compatible mock.
    registerSavingsAutoPayoutHeartbeat(app);
    expect(Object.keys(registeredRoutes)).toContain(SAVINGS_AUTO_PAYOUT_PATH);

    const handler = createSavingsAutoPayoutHandler({ authenticate, getDatabase: async () => db as any, runSweep });
    const invoke = async () => {
      let status = 200;
      let body: any;
      const response: any = { status(code: number) { status = code; return this; }, json(value: any) { body = value; return value; } };
      await handler({ headers: { cookie: "ignored-by-injected-auth" }, body: { planId: 999999 } } as any, response, () => undefined);
      return { status, body };
    };

    expect(await invoke()).toMatchObject({ status: 403, body: { error: "schedule_identity_mismatch" } });
    expect(runSweep).not.toHaveBeenCalled();
    configuredTaskUid = taskUid;
    expect(await invoke()).toMatchObject({ status: 200, body: { ok: true, processed: 0, scanned: 0 } });
    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(appSettings).toBeDefined();
  });
});

describe("external savings Cron authentication", () => {
  const externalSecret = "isolated-external-cron-test-secret-with-enough-entropy";
  const runSweep = vi.fn(async () => ({ processed: 0, scanned: 0, blocked: 0, failed: 0, skipped: 0 }));
  const getDatabase = vi.fn(async () => ({} as any));

  afterEach(() => {
    vi.unstubAllEnvs();
    runSweep.mockClear();
    getDatabase.mockClear();
  });

  async function invoke(headers: Record<string, string>) {
    const handler = createExternalSavingsAutoPayoutHandler({ getDatabase, runSweep });
    let status = 200;
    let body: any;
    const request: any = {
      method: "GET",
      path: SAVINGS_EXTERNAL_AUTO_PAYOUT_PATH,
      originalUrl: SAVINGS_EXTERNAL_AUTO_PAYOUT_PATH,
      header: (name: string) => headers[name.toLowerCase()],
    };
    const response: any = { status(code: number) { status = code; return this; }, json(value: any) { body = value; return value; } };
    await handler(request, response, () => undefined);
    return { status, body };
  }

  it("fails closed if no server secret is configured", async () => {
    vi.stubEnv("SAVINGS_CRON_SECRET", "");
    expect(await invoke({})).toMatchObject({ status: 503, body: { error: "cron_secret_unconfigured" } });
    expect(getDatabase).not.toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("accepts the constant-time shared secret supported by cron-job.org", async () => {
    vi.stubEnv("SAVINGS_CRON_SECRET", externalSecret);
    expect(await invoke({ "x-flotex-cron-secret": externalSecret })).toMatchObject({ status: 200, body: { ok: true, mode: "external-cron" } });
    expect(runSweep).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid time-bounded HMAC and rejects stale signatures before running the sweep", async () => {
    vi.stubEnv("SAVINGS_CRON_SECRET", externalSecret);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createSavingsCronSignature(externalSecret, timestamp, "GET", SAVINGS_EXTERNAL_AUTO_PAYOUT_PATH);
    expect(await invoke({ "x-flotex-cron-timestamp": timestamp, "x-flotex-cron-signature": signature })).toMatchObject({ status: 200, body: { ok: true } });
    expect(runSweep).toHaveBeenCalledTimes(1);

    runSweep.mockClear();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const staleSignature = createSavingsCronSignature(externalSecret, staleTimestamp, "GET", SAVINGS_EXTERNAL_AUTO_PAYOUT_PATH);
    expect(await invoke({ "x-flotex-cron-timestamp": staleTimestamp, "x-flotex-cron-signature": staleSignature })).toMatchObject({ status: 401, body: { error: "invalid_cron_secret" } });
    expect(runSweep).not.toHaveBeenCalled();
  });
});
