import { beforeEach, describe, expect, it, vi } from "vitest";
import { savingsFinancingEntries, savingsFinancingWallets, savingsPayouts, savingsPlans, users, wallets } from "../drizzle/schema";
import { confirmSavingsPayout, processAutomaticSavingsPayouts } from "../server/savings";
import { getNextSavingsPayoutAt } from "../shared/savings";

const testState = vi.hoisted(() => ({ database: null as any, plan: null as any, payoutRows: [] as any[], candidates: [] as any[] }));

vi.mock("../server/db", () => ({
  getDb: async () => testState.database,
  ensureWallet: vi.fn(),
}));
vi.mock("../server/payment-settings", () => ({
  requireAdministrator: async () => testState.database,
}));

const dueAt = new Date("2026-10-30T09:30:00.000Z");

describe("savings payout cadence and idempotency", () => {
  let planUpdates: any[];
  let writes: { table: unknown; values: any }[];
  let transaction: any;
  let transactionQueue: Promise<void>;

  beforeEach(() => {
    testState.plan = {
      id: 42,
      userId: 17,
      status: "active",
      nextPayoutAt: dueAt,
      frequency: "daily",
      principalAmount: "1000.00",
      ratePercent: "0.0548",
      ratePpm: 548,
      totalPaid: "0.00",
      totalAccrued: "0.0000",
      financingWalletId: 9,
      reference: "SAV-TEST-42",
    };
    testState.payoutRows = [];
    testState.candidates = [];
    planUpdates = [];
    writes = [];
    transactionQueue = Promise.resolve();

    transaction = {
      select: () => {
        let table: unknown;
        const builder: any = {
          from(value: unknown) { table = value; return builder; },
          where() { return builder; },
          for() { return builder; },
          async limit() {
            if (table === savingsPlans) return [testState.plan];
            if (table === savingsPayouts) return testState.payoutRows;
            if (table === savingsFinancingWallets) return [{ id: 9, adminId: 3, balance: "100.00" }];
            if (table === wallets) return [{ userId: 17, balance: "500.00", profitLoss: "0.00" }];
            if (table === users) return [{ name: "عميل اختبار", email: "admin@example.test" }];
            if (table === savingsFinancingEntries) return writes.filter((item) => item.table === savingsFinancingEntries).map((item) => ({ ...item.values, id: 1 }));
            return [];
          },
        };
        return builder;
      },
      update: (table: unknown) => ({
        set: (values: any) => ({
          where: async () => {
            writes.push({ table, values });
            if (table === savingsPlans) { Object.assign(testState.plan, values); planUpdates.push(values); }
            return { affectedRows: 1 };
          },
        }),
      }),
      insert: (table: unknown) => ({ values: async (values: any) => { writes.push({ table, values }); } }),
    };
    testState.database = {
      select: () => {
        let table: unknown;
        let ordered = false;
        const builder: any = {
          from(value: unknown) { table = value; return builder; },
          where() { return builder; },
          orderBy() { ordered = true; return builder; },
          async limit() {
            if (table === savingsPlans && ordered) return testState.candidates;
            if (table === savingsFinancingWallets) return [{ id: 9, adminId: 3 }];
            return [];
          },
        };
        return builder;
      },
      transaction: async (callback: (tx: any) => unknown) => {
        const previous = transactionQueue;
        let release!: () => void;
        transactionQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await callback(transaction); }
        finally { release(); }
      },
    };
  });

  it("anchors the next daily 24-hour period to the scheduled due time, not processing time", () => {
    const next = getNextSavingsPayoutAt(dueAt, "daily");
    expect(next.toISOString()).toBe("2026-10-31T09:30:00.000Z");
    expect(next.getTime() - dueAt.getTime()).toBe(24 * 60 * 60 * 1000);
    const delayedProcessingTime = new Date(dueAt.getTime() + 5 * 60 * 1000);
    expect(next.getTime()).not.toBe(getNextSavingsPayoutAt(delayedProcessingTime, "daily").getTime());
  });

  it("keeps a monthly payout anchored to the plan start after February", async () => {
    const startAt = new Date("2026-01-31T09:30:00.000Z");
    const periodStart = new Date("2026-02-28T09:30:00.000Z");
    testState.plan.frequency = "monthly";
    testState.plan.startAt = startAt;
    testState.plan.nextPayoutAt = periodStart;

    const result = await confirmSavingsPayout(3, 42, new Date(periodStart.getTime() + 300_000), { automatic: true });

    expect(result.status).toBe("paid");
    expect(planUpdates[0].nextPayoutAt.toISOString()).toBe("2026-03-31T09:30:00.000Z");
  });

  it("pays the simulated due day once and advances nextPayoutAt from the due boundary", async () => {
    const runAt = new Date(dueAt.getTime() + 5 * 60 * 1000);
    const first = await confirmSavingsPayout(3, 42, runAt, { automatic: true });
    expect(first.status).toBe("paid");
    expect(planUpdates[0].nextPayoutAt.toISOString()).toBe("2026-10-31T09:30:00.000Z");
    expect(writes.filter((item) => item.table === savingsPayouts)).toHaveLength(1);
    expect(writes.filter((item) => item.table === savingsFinancingEntries)).toHaveLength(1);

    const writesAfterFirst = writes.length;
    const second = await confirmSavingsPayout(3, 42, runAt, { automatic: true });
    expect(second.status).toBe("not_due");
    expect(writes).toHaveLength(writesAfterFirst);
  });

  it("anchors manual administrator confirmation to the same 24-hour period boundary", async () => {
    const result = await confirmSavingsPayout(3, 42, dueAt);
    expect(result.status).toBe("paid");
    expect(planUpdates[0].nextPayoutAt.toISOString()).toBe("2026-10-31T09:30:00.000Z");
  });

  it("background-sweeps an eligible plan at five minutes, but not before, without touching a real DB", async () => {
    testState.candidates = [{ id: 42, financingWalletId: 9 }];
    const beforeGraceEnds = await processAutomaticSavingsPayouts(new Date(dueAt.getTime() + 299_999));
    expect(beforeGraceEnds).toMatchObject({ processed: 0, scanned: 1, failed: 0 });
    expect(writes).toHaveLength(0);

    const atGraceBoundary = await processAutomaticSavingsPayouts(new Date(dueAt.getTime() + 300_000));
    expect(atGraceBoundary).toMatchObject({ processed: 1, scanned: 1, blocked: 0, failed: 0, skipped: 0 });
    expect(writes.filter((item) => item.table === savingsPayouts)).toHaveLength(1);
    expect(planUpdates[0].nextPayoutAt.toISOString()).toBe("2026-10-31T09:30:00.000Z");
  });

  it("does not credit a period already marked paid even if a duplicate callback races", async () => {
    const repeatedDueAt = new Date(dueAt.getTime() + 24 * 60 * 60 * 1000);
    testState.plan.nextPayoutAt = repeatedDueAt;
    testState.payoutRows = [{ id: 8, planId: 42, periodKey: "daily:2026-10-31", status: "paid", paidAmount: "0.55" }];
    const before = writes.length;
    const result = await confirmSavingsPayout(3, 42, new Date(repeatedDueAt.getTime() + 5 * 60 * 1000), { automatic: true });
    expect(result.status).toBe("already_paid");
    expect(writes).toHaveLength(before);
  });

  it("serializes simultaneous payout callbacks so exactly one can credit the period", async () => {
    const runAt = new Date(dueAt.getTime() + 5 * 60 * 1000);
    const results = await Promise.all([
      confirmSavingsPayout(3, 42, runAt, { automatic: true }),
      confirmSavingsPayout(3, 42, runAt, { automatic: true }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["not_due", "paid"]);
    expect(writes.filter((item) => item.table === savingsPayouts)).toHaveLength(1);
    expect(writes.filter((item) => item.table === savingsFinancingEntries)).toHaveLength(1);
  });

  it.each(["refunded", "completed"]) ("stops payouts after a plan is %s", async (status) => {
    testState.plan.status = status;
    testState.plan.nextPayoutAt = null;
    const result = await confirmSavingsPayout(3, 42, new Date("2026-11-05T00:00:00.000Z"), { automatic: true });
    expect(result.status).toBe("not_due");
    expect(writes).toHaveLength(0);
  });
});
