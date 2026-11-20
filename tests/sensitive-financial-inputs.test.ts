import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
describe("sensitive financial and identity input lifecycle", () => {
  it("does not send transfer PIN through a React Query mutation", () => {
    const source = read("app/transfer.tsx");
    expect(source).toContain("useEphemeralMutation(manualAuthClient.transfers.create.mutate)");
    expect(source).not.toContain("trpc.transfers.create.useMutation");
    expect(source).toContain('finally { setSecurityPin(""); }');
  });
  it("uses a PIN-free retry snapshot and direct RPC for withdrawal", () => {
    const source = read("components/payments/PaymentFlow.tsx");
    expect(source).toContain("useEphemeralMutation(manualAuthClient.portfolio.request.mutate)");
    expect(source).toContain("payloadRef.current = { signature, payload: retryPayload }");
    expect(source).not.toContain("payloadRef.current = { signature, payload };");
    expect(source).toContain('setSecurityPin("")');
  });
  it("does not keep account documents/national ID in a query mutation cache", () => {
    const source = read("app/account-verification.tsx");
    expect(source).toContain("useEphemeralMutation(manualAuthClient.accountVerification.submit.mutate)");
    expect(source).toContain("useEphemeralMutation(manualAuthClient.auth.updateNationalId.mutate)");
    expect(source).not.toContain("AsyncStorage.setItem");
  });
  it("does not keep phone-change documents in a query mutation cache", () => {
    const source = read("app/change-phone.tsx");
    expect(source).toContain("useEphemeralMutation(manualAuthClient.auth.submitPhoneChange.mutate)");
    expect(source).not.toContain("trpc.auth.submitPhoneChange.useMutation");
  });
});
