import { describe, expect, it } from "vitest";
import {
  authenticatedHomeRoute,
  isAdministrativeRoute,
  isPublicUnauthenticatedRoute,
  shouldRedirectAuthenticatedUser,
} from "../shared/auth-routing";

describe("authenticated home routing", () => {
  it("sends customers to the home dashboard and administrators to control", () => {
    expect(authenticatedHomeRoute("user")).toBe("/(tabs)");
    expect(authenticatedHomeRoute("admin")).toBe("/control");
    expect(authenticatedHomeRoute(null)).toBe("/(tabs)");
  });
});

describe("unauthenticated route policy", () => {
  it("allows login entry, registration, password recovery, and the profile Logout handoff", () => {
    expect(isPublicUnauthenticatedRoute(["index"])).toBe(true);
    expect(isPublicUnauthenticatedRoute(["register"])).toBe(true);
    expect(isPublicUnauthenticatedRoute(["forgot-password"])).toBe(true);
    expect(isPublicUnauthenticatedRoute(["(tabs)", "index"])).toBe(true);
    expect(isPublicUnauthenticatedRoute(["(tabs)", "profile"])).toBe(true);
  });

  it("blocks application data and operational screens until authentication", () => {
    expect(isPublicUnauthenticatedRoute(["(tabs)", "wallet"])).toBe(false);
    expect(isPublicUnauthenticatedRoute(["(tabs)", "activity"])).toBe(false);
    expect(isPublicUnauthenticatedRoute(["deposit"])).toBe(false);
    expect(isPublicUnauthenticatedRoute(["withdrawal"])).toBe(false);
    expect(isPublicUnauthenticatedRoute(["transfer"])).toBe(false);
    expect(isPublicUnauthenticatedRoute(["control"])).toBe(false);
    expect(isPublicUnauthenticatedRoute(["onboarding"])).toBe(false);
  });

  it("keeps the signed-in home tab available but redirects signed-in auth forms", () => {
    expect(shouldRedirectAuthenticatedUser(["register"])).toBe(true);
    expect(shouldRedirectAuthenticatedUser(["forgot-password"])).toBe(true);
    expect(shouldRedirectAuthenticatedUser(["index"])).toBe(true);
    expect(shouldRedirectAuthenticatedUser(["(tabs)", "index"])).toBe(false);
  });

  it("identifies administrative routes for role-based redirects", () => {
    expect(isAdministrativeRoute(["control"])).toBe(true);
    expect(isAdministrativeRoute(["admin"])).toBe(true);
    expect(isAdministrativeRoute(["(tabs)", "wallet"])).toBe(false);
  });
});
