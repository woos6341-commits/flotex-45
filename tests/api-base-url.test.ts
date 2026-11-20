import { describe, expect, it } from "vitest";
import {
  FLOTEX_PRODUCTION_API_BASE_URL,
  resolveApiBaseUrl,
} from "../shared/api-base-url";

describe("resolveApiBaseUrl", () => {
  it("maps Manus Expo Preview to the matching API port", () => {
    expect(resolveApiBaseUrl({
      platform: "web",
      isDevelopment: true,
      location: {
        protocol: "https:",
        hostname: "8081-session.us5.manus.computer",
        origin: "https://8081-session.us5.manus.computer",
      },
    })).toBe("https://3000-session.us5.manus.computer");
  });

  it("keeps local web development on port 3000", () => {
    expect(resolveApiBaseUrl({
      platform: "web",
      isDevelopment: true,
      location: { protocol: "http:", hostname: "localhost", port: "8081", origin: "http://localhost:8081" },
    })).toBe("http://localhost:3000");
  });

  it("prefers the injected paired API when the Preview renderer is internal localhost", () => {
    expect(resolveApiBaseUrl({
      platform: "web",
      isDevelopment: true,
      configuredBaseUrl: "https://3000-session.us5.manus.computer",
      location: { protocol: "http:", hostname: "localhost", port: "8081", origin: "http://localhost:8081" },
    })).toBe("https://3000-session.us5.manus.computer");
  });

  it("uses the published web origin for production", () => {
    expect(resolveApiBaseUrl({
      platform: "web",
      isDevelopment: false,
      configuredBaseUrl: "https://stale-preview.manus.computer",
      location: { protocol: "https:", hostname: "flotex2-independent.manus.space", origin: "https://flotex2-independent.manus.space" },
    })).toBe("https://flotex2-independent.manus.space");
  });

  it("keeps the injected API URL for a native development build", () => {
    expect(resolveApiBaseUrl({
      platform: "native",
      isDevelopment: true,
      configuredBaseUrl: "https://3000-session.us5.manus.computer/",
    })).toBe("https://3000-session.us5.manus.computer");
  });

  it("does not embed Preview or the source project's production API in a native release", () => {
    expect(FLOTEX_PRODUCTION_API_BASE_URL).toBe("");
    expect(resolveApiBaseUrl({
      platform: "native",
      isDevelopment: false,
      configuredBaseUrl: "https://3000-session.us5.manus.computer",
    })).toBe("");
  });

  it("accepts a stable published API override for a native release", () => {
    expect(resolveApiBaseUrl({
      platform: "native",
      isDevelopment: false,
      configuredBaseUrl: "https://flotex2-independent.manus.space/",
    })).toBe("https://flotex2-independent.manus.space");
  });
});
