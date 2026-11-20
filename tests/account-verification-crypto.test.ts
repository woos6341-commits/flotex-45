import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeAccountVerificationImage,
  decryptAccountVerificationDocument,
  encryptAccountVerificationDocument,
  fingerprintAccountVerificationValue,
} from "../server/account-verification-crypto";

beforeEach(() => {
  vi.stubEnv("KYC_DOCUMENT_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
});
afterEach(() => vi.unstubAllEnvs());

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);

describe("private account verification documents", () => {
  it("accepts matching JPEG content and encrypts it with authenticated encryption", () => {
    const bytes = decodeAccountVerificationImage({ mimeType: "image/jpeg", data: jpeg.toString("base64") });
    const encrypted = encryptAccountVerificationDocument(bytes);
    expect(encrypted).not.toBe(bytes.toString("base64"));
    expect(decryptAccountVerificationDocument(encrypted)).toEqual(bytes);
  });

  it("rejects content whose bytes do not match the declared MIME type", () => {
    expect(() => decodeAccountVerificationImage({ mimeType: "image/png", data: jpeg.toString("base64") })).toThrow("محتوى الملف");
    expect(() => decodeAccountVerificationImage({ mimeType: "image/jpeg", data: "not-base64!" })).toThrow("اختر صورة");
  });

  it("rejects documents larger than 2 MiB", () => {
    const oversized = Buffer.concat([jpeg, Buffer.alloc(2 * 1024 * 1024)]);
    expect(() => decodeAccountVerificationImage({ mimeType: "image/jpeg", data: oversized.toString("base64") })).toThrow("2 ميجابايت");
  });

  it("requires the dedicated KYC key instead of falling back to the OTP secret", () => {
    vi.stubEnv("KYC_DOCUMENT_ENCRYPTION_KEY", "");
    vi.stubEnv("APP_VERIFICATION_SECRET", "synthetic-otp-secret-that-must-not-encrypt-kyc-documents");
    expect(() => encryptAccountVerificationDocument(jpeg)).toThrow("KYC_DOCUMENT_ENCRYPTION_KEY");
  });

  it("creates a stable keyed fingerprint that is separated by data purpose", () => {
    const first = fingerprintAccountVerificationValue("national-id", "29001010100001");
    expect(fingerprintAccountVerificationValue("national-id", "29001010100001")).toBe(first);
    expect(fingerprintAccountVerificationValue("phone", "29001010100001")).not.toBe(first);
  });
});
