import { afterEach, describe, expect, it } from "vitest";
import { getSessionCookieName, getSessionCookieOptions } from "../server/_core/cookies";

const originalPackagerProxy = process.env.EXPO_PACKAGER_PROXY_URL;
const originalPreviewUrl = process.env.EXPO_WEB_PREVIEW_URL;

afterEach(() => {
  if (originalPackagerProxy === undefined) delete process.env.EXPO_PACKAGER_PROXY_URL;
  else process.env.EXPO_PACKAGER_PROXY_URL = originalPackagerProxy;
  if (originalPreviewUrl === undefined) delete process.env.EXPO_WEB_PREVIEW_URL;
  else process.env.EXPO_WEB_PREVIEW_URL = originalPreviewUrl;
});

function request(hostname: string, protocol = "http") {
  return { hostname, protocol, headers: {} } as any;
}

describe("session cookies", () => {
  it("uses a secure cross-site cookie for the public Manus Preview API", () => {
    process.env.EXPO_PACKAGER_PROXY_URL = "https://8081-preview.example.manus.computer";
    process.env.EXPO_WEB_PREVIEW_URL = "https://8328-preview.example.manus.computer";
    const req = request("3000-preview.example.manus.computer");

    expect(getSessionCookieOptions(req)).toMatchObject({ secure: true, sameSite: "none" });
    expect(getSessionCookieName(req)).toMatch(/^__Host-manus_session_/);
  });

  it("keeps local development cookies non-secure", () => {
    process.env.EXPO_PACKAGER_PROXY_URL = "https://8081-preview.example.manus.computer";
    process.env.EXPO_WEB_PREVIEW_URL = "https://8328-preview.example.manus.computer";
    const req = request("127.0.0.1");

    expect(getSessionCookieOptions(req)).toMatchObject({ secure: false, sameSite: "lax" });
    expect(getSessionCookieName(req)).toMatch(/^manus_local_session_/);
  });
});
