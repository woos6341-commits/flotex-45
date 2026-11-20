import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("manual verification redemption without an order number", () => {
  it.each(["app/register.tsx", "app/forgot-password.tsx"])("asks only for the email already in context and the code in %s", (path) => {
    const source = read(path);
    expect(source).not.toContain("رقم طلب الرمز اليدوي");
    expect(source).not.toContain("رقم الطلب والرمز");
    expect(source).toContain("email:");
    expect(source).toContain("code:");
    expect(source).not.toMatch(/redeemManual\.mutateAsync\(\{\s*id:/);
  });
});
