import { describe,expect,it } from "vitest";
import { decodePaymentImage,decryptReceipt,encryptReceipt } from "../server/payment-media";
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=";
describe("private payment receipt protection",()=>{
  it("encrypts receipt bytes and restores the original image",()=>{
    const ciphertext=encryptReceipt(png);expect(ciphertext.toString().includes(png)).toBe(false);expect(decryptReceipt(ciphertext)).toBe(png);
  });
  it("rejects tampering and cannot reuse the same ciphertext nonce",()=>{
    const a=encryptReceipt(png),b=encryptReceipt(png);expect(a.equals(b)).toBe(false);a[a.length-1]^=1;expect(()=>decryptReceipt(a)).toThrow();
  });
  it("rejects data masquerading as a supported image",()=>{
    expect(()=>decodePaymentImage("data:image/png;base64,ZmFrZQ==")).toThrow("محتوى");expect(()=>decodePaymentImage("data:image/svg+xml;base64,PHN2Zz4=" )).toThrow();
  });
});
