import { describe, expect, it } from "vitest";
import { normalizeContactButtonTarget } from "../shared/contact-buttons";

describe("normalizeContactButtonTarget", () => {
  it("turns an Egyptian WhatsApp mobile number into a country-code chat link", () => {
    expect(normalizeContactButtonTarget("whatsapp", "01012345678")).toBe("https://wa.me/201012345678");
  });

  it("preserves valid WhatsApp chat URLs", () => {
    expect(normalizeContactButtonTarget("whatsapp", "https://wa.me/201012345678")).toBe("https://wa.me/201012345678");
  });

  it("turns a Telegram username into a direct HTTPS profile link", () => {
    expect(normalizeContactButtonTarget("telegram", "@flotex_help")).toBe("https://t.me/flotex_help");
  });

  it("allows Telegram invitation links and custom HTTPS links", () => {
    expect(normalizeContactButtonTarget("telegram", "https://t.me/+InviteCode")).toBe("https://t.me/+InviteCode");
    expect(normalizeContactButtonTarget("custom", "https://example.com/help")).toBe("https://example.com/help");
  });

  it("rejects unsafe protocols, credentials, and unrelated service domains", () => {
    expect(() => normalizeContactButtonTarget("custom", "javascript:alert(1)")).toThrow();
    expect(() => normalizeContactButtonTarget("custom", "http://example.com")).toThrow();
    expect(() => normalizeContactButtonTarget("custom", "https://user:password@example.com")).toThrow();
    expect(() => normalizeContactButtonTarget("whatsapp", "https://example.com/chat")).toThrow();
    expect(() => normalizeContactButtonTarget("telegram", "https://evil.example/chat")).toThrow();
  });

  it("rejects invalid phone numbers and incomplete chat links", () => {
    expect(() => normalizeContactButtonTarget("whatsapp", "123")).toThrow();
    expect(() => normalizeContactButtonTarget("telegram", "https://t.me/")).toThrow();
  });
});
