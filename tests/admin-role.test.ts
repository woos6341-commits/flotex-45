import { describe, expect, it } from "vitest";
import { roleForUserUpsert } from "../shared/admin";

describe("admin role persistence", () => {
  it("preserves the existing role when a session refresh omits email", () => {
    expect(roleForUserUpsert(undefined, "admin")).toBe("admin");
    expect(roleForUserUpsert(null, "admin")).toBe("admin");
    expect(roleForUserUpsert(undefined, "user")).toBe("user");
  });

  it("grants admin only to the configured email, case-insensitively", () => {
    expect(roleForUserUpsert(" DYBLHWYTY@GMAIL.COM ", "user")).toBe("admin");
    expect(roleForUserUpsert("someone@example.com", "admin")).toBe("user");
  });

  it("defaults new accounts to user when no email is available", () => {
    expect(roleForUserUpsert(undefined)).toBe("user");
  });
});
