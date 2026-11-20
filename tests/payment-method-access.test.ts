import { describe, expect, it } from "vitest";
import { resolvePaymentMethodAccess } from "../shared/payment-method-access";

describe("resolvePaymentMethodAccess", () => {
  it("allows both directions when no override or legacy block exists", () => {
    expect(resolvePaymentMethodAccess(undefined, false)).toEqual({ depositEnabled: true, withdrawalEnabled: true });
  });

  it("keeps a legacy block effective until an override exists", () => {
    expect(resolvePaymentMethodAccess(null, true)).toEqual({ depositEnabled: false, withdrawalEnabled: false });
  });

  it("uses an explicit override for both directions despite a legacy block", () => {
    expect(resolvePaymentMethodAccess({ depositEnabled: 1, withdrawalEnabled: 0 }, true)).toEqual({ depositEnabled: true, withdrawalEnabled: false });
  });

  it("allows withdrawals while deposits are independently disabled", () => {
    expect(resolvePaymentMethodAccess({ depositEnabled: 0, withdrawalEnabled: 1 }, false)).toEqual({ depositEnabled: false, withdrawalEnabled: true });
  });

  it("supports disabling both directions explicitly", () => {
    expect(resolvePaymentMethodAccess({ depositEnabled: 0, withdrawalEnabled: 0 }, false)).toEqual({ depositEnabled: false, withdrawalEnabled: false });
  });
});
