import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ database: null as any }));

vi.mock("../server/db", () => ({
  getDb: async () => testState.database,
  ensureWallet: vi.fn(),
}));

import { cancelSavingsPlan } from "../server/savings";
import { notifications, savingsPlans, transactions, wallets } from "../drizzle/schema";

describe("pending savings cancellation", () => {
  let plan: any;
  let wallet: any;
  let walletUpdates: number;
  let notificationsWritten: any[];
  let transactionUpdates: number;

  beforeEach(() => {
    plan = { id: 92, userId: 7, status: "pending_approval", reference: "SAV-7-test", principalAmount: "1000.00", feeAmount: "1.00" };
    wallet = { userId: 7, balance: "5000.00", reservedSavings: "1001.00" };
    walletUpdates = 0;
    notificationsWritten = [];
    transactionUpdates = 0;

    const tx = {
      select: () => {
        let table: unknown;
        const builder: any = {
          from(value: unknown) { table = value; return builder; },
          where() { return builder; },
          for() { return builder; },
          async limit() {
            if (table === savingsPlans) return [plan];
            if (table === wallets) return [wallet];
            return [];
          },
        };
        return builder;
      },
      update: (table: unknown) => ({
        set: (values: any) => ({
          where: async () => {
            if (table === wallets) { walletUpdates += 1; expect(values.reservedSavings).toBeDefined(); }
            if (table === savingsPlans) Object.assign(plan, values);
            if (table === transactions) transactionUpdates += 1;
            return [{ affectedRows: 1 }];
          },
        }),
      }),
      insert: (table: unknown) => ({ values: async (values: any) => {
        if (table === notifications) notificationsWritten.push(values);
      } }),
    };
    testState.database = { transaction: async (callback: (transaction: any) => unknown) => callback(tx) };
  });

  it("releases the full held principal-plus-fee reservation and logs cancellation", async () => {
    const result = await cancelSavingsPlan(7, 92);
    expect(result).toMatchObject({ success: true, status: "cancelled", releasedAmount: "1001.00", duplicate: false });
    expect(plan.status).toBe("cancelled");
    expect(walletUpdates).toBe(1);
    expect(transactionUpdates).toBe(1);
    expect(notificationsWritten).toHaveLength(1);
  });

  it("returns an idempotent result on repeated cancellation without touching the wallet", async () => {
    plan.status = "cancelled";
    const result = await cancelSavingsPlan(7, 92);
    expect(result).toMatchObject({ success: true, status: "cancelled", releasedAmount: "0.00", duplicate: true });
    expect(walletUpdates).toBe(0);
    expect(transactionUpdates).toBe(0);
    expect(notificationsWritten).toHaveLength(0);
  });
});
