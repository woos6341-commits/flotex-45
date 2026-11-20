import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountVerifications, appSettings, requests, users, wallets } from "../drizzle/schema";
import { createRequest } from "../server/db";

const state = vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://mock:mock@127.0.0.1/flotex_test_mock";
  return {
    database: null as any,
    required: true,
    status: null as string | null,
    serviceStatus: { depositEnabled: true, withdrawalEnabled: true },
    paymentMethodLookups: 0,
    transactionCalls: 0,
    rootWriteCalls: 0,
    mockInserts: [] as { table: unknown; values: unknown }[],
    wallet: {
      id: 1,
      userId: 41,
      balance: "100.00",
      reservedWithdrawals: "0.00",
      reservedOrders: "0.00",
      reservedTransfers: "0.00",
      reservedSavings: "0.00",
      currency: "EGP",
    },
    paymentMethods: [{ id: "test-method", name: "Vodafone Cash", transferNumber: "01012345678", fields: [] }],
  };
});
const previousLocalDbFlag = process.env.FLOTEX_RUN_LOCAL_DB_TESTS;

vi.mock("drizzle-orm/mysql2", () => ({ drizzle: () => state.database }));
vi.mock("../server/payment-settings", () => ({
  getFeePolicy: async () => null,
  getPaymentMethods: async () => { state.paymentMethodLookups += 1; return state.paymentMethods; },
  getPaymentServiceStatus: async () => state.serviceStatus,
  getPaymentLimits: async () => ({ minDepositAmount: 1, minWithdrawalAmount: 1, maxDepositAmount: null, maxWithdrawalAmount: null }),
  updatePaymentLimits: async () => undefined,
  requireAdministrator: async () => state.database,
}));
vi.mock("../server/payment-media", () => ({
  saveReceipt: vi.fn(async () => "mock-private-receipt"),
  decodePaymentImage: vi.fn(),
  readReceipt: vi.fn(),
}));
vi.mock("../server/push", () => ({ sendPushOnce: vi.fn() }));
vi.mock("../server/push-messages", () => ({ buildRequestSubmittedPush: () => ({ title: "test", body: "test" }) }));
vi.mock("../server/providers/market-data", () => ({ getMarketDataProvider: vi.fn() }));
vi.mock("../server/balance-adjustment", () => ({ applyBalanceAdjustment: vi.fn() }));

function rowsFor(table: unknown) {
  if (table === users) return [{ id: 41, role: "user" }];
  if (table === appSettings) return [{ value: state.required ? "true" : "false" }];
  if (table === accountVerifications && state.status) return [{ status: state.status }];
  if (table === wallets) return [{ ...state.wallet }];
  if (table === requests) return [];
  return [];
}

function makeSelectBuilder() {
  let table: unknown;
  const builder: any = {
    from(value: unknown) { table = value; return builder; },
    where() { return builder; },
    for() { return builder; },
    async limit() { return rowsFor(table); },
  };
  return builder;
}

function makeDb() {
  const tx = {
    select: () => makeSelectBuilder(),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        state.mockInserts.push({ table, values });
        return [{ insertId: state.mockInserts.length }];
      },
    }),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: 1 }] }) }),
  };
  return {
    select: () => makeSelectBuilder(),
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      state.transactionCalls += 1;
      return callback(tx);
    },
    insert: () => { state.rootWriteCalls += 1; throw new Error("unexpected-root-write"); },
    update: () => { state.rootWriteCalls += 1; throw new Error("unexpected-root-write"); },
  };
}

async function submitMockRequest(type: "deposit" | "withdrawal", operationId: string) {
  return createRequest(
    41,
    type,
    "10.00",
    undefined,
    undefined,
    undefined,
    type === "withdrawal" ? "01012345678" : undefined,
    type === "deposit" ? "data:image/png;base64,AQ==" : undefined,
    { paymentMethodId: "test-method", operationId, senderReference: type === "deposit" ? "sender-01012345678" : undefined },
  );
}

describe("createRequest account-verification gate (memory-only database mocks)", () => {
  beforeEach(() => {
    process.env.FLOTEX_RUN_LOCAL_DB_TESTS = "1";
    state.required = true;
    state.status = null;
    state.serviceStatus = { depositEnabled: true, withdrawalEnabled: true };
    state.paymentMethodLookups = 0;
    state.transactionCalls = 0;
    state.rootWriteCalls = 0;
    state.mockInserts = [];
    state.database = makeDb();
  });
  afterEach(() => {
    if (previousLocalDbFlag === undefined) delete process.env.FLOTEX_RUN_LOCAL_DB_TESTS;
    else process.env.FLOTEX_RUN_LOCAL_DB_TESTS = previousLocalDbFlag;
  });

  it("rejects unverified deposits and withdrawals before looking up payment methods or writing", async () => {
    for (const type of ["deposit", "withdrawal"] as const) {
      for (const status of [null, "pending", "rejected"] as const) {
        state.status = status;
        await expect(submitMockRequest(type, `blocked-${type}-${status ?? "none"}-0001`)).rejects.toThrow("يرجى توثيق حسابك أولًا لإتمام العملية");
      }
    }
    expect(state.paymentMethodLookups).toBe(0);
    expect(state.transactionCalls).toBe(0);
    expect(state.rootWriteCalls).toBe(0);
    expect(state.mockInserts).toHaveLength(0);
  });

  it("completes mocked deposit and withdrawal requests after approval and when the requirement is disabled", async () => {
    const references: string[] = [];
    for (const scenario of [
      { required: true, status: "approved", id: "approved" },
      { required: false, status: null, id: "disabled" },
    ] as const) {
      state.required = scenario.required;
      state.status = scenario.status;
      references.push(await submitMockRequest("deposit", `deposit-${scenario.id}-0001`));
      references.push(await submitMockRequest("withdrawal", `withdrawal-${scenario.id}-0001`));
    }

    expect(references).toHaveLength(4);
    expect(references.filter((reference) => reference.startsWith("ATH-DEP-")).length).toBe(2);
    expect(references.filter((reference) => reference.startsWith("ATH-WDR-")).length).toBe(2);
    expect(state.paymentMethodLookups).toBe(4);
    expect(state.transactionCalls).toBe(4);
    expect(state.rootWriteCalls).toBe(0);
    expect(state.mockInserts.filter((entry) => entry.table === requests)).toHaveLength(4);
  });

  it("keeps deposit and withdrawal independently controllable in all four states", async () => {
    const cases = [
      { depositEnabled: true, withdrawalEnabled: true, deposit: true, withdrawal: true },
      { depositEnabled: false, withdrawalEnabled: true, deposit: false, withdrawal: true },
      { depositEnabled: true, withdrawalEnabled: false, deposit: true, withdrawal: false },
      { depositEnabled: false, withdrawalEnabled: false, deposit: false, withdrawal: false },
    ] as const;
    state.required = false;
    state.status = null;
    for (const scenario of cases) {
      state.serviceStatus = { depositEnabled: scenario.depositEnabled, withdrawalEnabled: scenario.withdrawalEnabled };
      if (scenario.deposit) await expect(submitMockRequest("deposit", `four-deposit-${scenario.depositEnabled}-${scenario.withdrawalEnabled}-0001`)).resolves.toMatch(/^ATH-DEP-/);
      else await expect(submitMockRequest("deposit", `four-deposit-${scenario.depositEnabled}-${scenario.withdrawalEnabled}-0001`)).rejects.toThrow("الإيداع متوقف مؤقتًا");
      if (scenario.withdrawal) await expect(submitMockRequest("withdrawal", `four-withdrawal-${scenario.depositEnabled}-${scenario.withdrawalEnabled}-0001`)).resolves.toMatch(/^ATH-WDR-/);
      else await expect(submitMockRequest("withdrawal", `four-withdrawal-${scenario.depositEnabled}-${scenario.withdrawalEnabled}-0001`)).rejects.toThrow("السحب متوقف مؤقتًا");
    }
  });
});
