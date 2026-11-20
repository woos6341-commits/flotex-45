import { describe, expect, it } from "vitest";
import { assertMoneyRequestVerificationAllowed } from "../server/money-request-verification";
import { ACCOUNT_VERIFICATION_REQUIRED_MESSAGE } from "../shared/account-verification-policy";
import { accountVerifications, appSettings } from "../drizzle/schema";

type MockState = { enabled: boolean; status: string | null };
function mockDb(state: MockState): any {
  return {
    select: () => {
      let table: unknown;
      const builder: any = {
        from(value: unknown) { table = value; return builder; },
        where() { return builder; },
        async limit() {
          if (table === appSettings) return [{ value: state.enabled ? "true" : "false" }];
          if (table === accountVerifications && state.status) return [{ status: state.status }];
          return [];
        },
      };
      return builder;
    },
  };
}

const FLOWS = ["deposit", "withdrawal"] as const;

describe("server money request verification guard (isolated DB mock)", () => {
  it("blocks unverified deposits and withdrawals before payment creation", async () => {
    const state: MockState = { enabled: true, status: null };
    const db = mockDb(state);
    for (const type of FLOWS) {
      state.status = null;
      await expect(assertMoneyRequestVerificationAllowed(db, 41, "user", type)).rejects.toThrow(ACCOUNT_VERIFICATION_REQUIRED_MESSAGE);
      state.status = "pending";
      await expect(assertMoneyRequestVerificationAllowed(db, 41, "user", type)).rejects.toThrow(ACCOUNT_VERIFICATION_REQUIRED_MESSAGE);
      state.status = "rejected";
      await expect(assertMoneyRequestVerificationAllowed(db, 41, "user", type)).rejects.toThrow(ACCOUNT_VERIFICATION_REQUIRED_MESSAGE);
    }
  });

  it("allows both flows after manual approval and for unverified users when the switch is off", async () => {
    const state: MockState = { enabled: true, status: "approved" };
    const db = mockDb(state);
    for (const type of FLOWS) {
      await expect(assertMoneyRequestVerificationAllowed(db, 41, "user", type)).resolves.toBeUndefined();
      state.status = null;
      state.enabled = false;
      await expect(assertMoneyRequestVerificationAllowed(db, 41, "user", type)).resolves.toBeUndefined();
      state.enabled = true;
      state.status = "approved";
    }
  });

  it("keeps the administrator bypass and performs no financial writes", async () => {
    const db = mockDb({ enabled: true, status: null });
    await expect(assertMoneyRequestVerificationAllowed(db, 1, "admin", "deposit")).resolves.toBeUndefined();
    expect("createRequest" in db).toBe(false);
  });
});
