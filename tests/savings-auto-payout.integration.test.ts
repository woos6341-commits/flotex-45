import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  cashLedger,
  notifications,
  savingsFinancingEntries,
  savingsFinancingWallets,
  savingsPayouts,
  savingsPlans,
  transactions,
  users,
  wallets,
} from "../drizzle/schema";
import { ADMIN_EMAIL } from "../shared/admin";
import { getDb } from "../server/db";
import { processAutomaticSavingsPayouts } from "../server/savings";

const TEST_CUSTOMER_EMAIL = `flotex-savings-cron-test-${Date.now()}@example.test`;
let fixture: { customerId: number; adminId: number; planId: number; financingWalletId: number } | null = null;

function assertIsIsolatedLocalDatabase() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for local savings integration tests.");
  const database = new URL(rawUrl);
  if (database.hostname !== "127.0.0.1" || !database.pathname.startsWith("/flotex_test_")) {
    throw new Error("Refusing savings integration test: DATABASE_URL must target a loopback-only flotex_test_* database.");
  }
}

beforeAll(() => assertIsIsolatedLocalDatabase());

afterEach(async () => {
  if (!fixture) return;
  const db = await getDb();
  if (!db) throw new Error("The isolated local MariaDB connection is unavailable during fixture cleanup.");
  await db.delete(notifications).where(eq(notifications.userId, fixture.customerId));
  await db.delete(cashLedger).where(eq(cashLedger.userId, fixture.customerId));
  await db.delete(transactions).where(eq(transactions.userId, fixture.customerId));
  await db.delete(savingsFinancingEntries).where(eq(savingsFinancingEntries.walletId, fixture.financingWalletId));
  await db.delete(savingsPayouts).where(eq(savingsPayouts.planId, fixture.planId));
  await db.delete(savingsPlans).where(eq(savingsPlans.id, fixture.planId));
  await db.delete(wallets).where(eq(wallets.userId, fixture.customerId));
  await db.delete(savingsFinancingWallets).where(eq(savingsFinancingWallets.id, fixture.financingWalletId));
  await db.delete(users).where(and(eq(users.id, fixture.customerId)));
  await db.delete(users).where(eq(users.id, fixture.adminId));
  fixture = null;
});

describe("automatic savings payouts on isolated local MariaDB", () => {
  it("credits a due period once when two Cron sweeps race", async () => {
    assertIsIsolatedLocalDatabase();
    const db = await getDb();
    if (!db) throw new Error("The isolated local MariaDB connection is unavailable.");
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) throw new Error("Refusing savings integration test because the isolated test database contains a user.");

    const createdAt = new Date("2026-11-09T09:30:00.000Z");
    const dueAt = new Date("2026-11-10T09:30:00.000Z");
    const now = new Date(dueAt.getTime() + 5 * 60 * 1000);
    const unique = Date.now().toString();
    await db.insert(users).values([
      {
        openId: `savings-cron-user:${unique}`,
        customerId: unique.slice(-10).padStart(10, "0"),
        name: "عميل اختبار عائد محلي",
        email: TEST_CUSTOMER_EMAIL,
        emailNormalized: TEST_CUSTOMER_EMAIL,
        role: "user",
        status: "active",
        deletedAt: null,
        lastSignedIn: createdAt,
      },
      {
        openId: `savings-cron-admin:${unique}`,
        customerId: "9876543210",
        name: "مدير اختبار محلي",
        email: ADMIN_EMAIL,
        emailNormalized: ADMIN_EMAIL,
        role: "admin",
        status: "active",
        deletedAt: null,
        lastSignedIn: createdAt,
      },
    ]);
    const [customer] = await db.select().from(users).where(eq(users.emailNormalized, TEST_CUSTOMER_EMAIL)).limit(1);
    const [admin] = await db.select().from(users).where(eq(users.emailNormalized, ADMIN_EMAIL)).limit(1);
    if (!customer || !admin) throw new Error("Could not create synthetic local savings accounts.");

    await db.insert(wallets).values({
      userId: customer.id,
      balance: "0.00",
      reservedWithdrawals: "0.00",
      reservedOrders: "0.00",
      reservedTransfers: "0.00",
      reservedSavings: "0.00",
      profitLoss: "0.00",
      currency: "EGP",
    });
    const [financingWallet] = await db.insert(savingsFinancingWallets).values({ adminId: admin.id, name: "تمويل اصطناعي للاختبار", balance: "100.00", currency: "EGP" }).$returningId();
    const [plan] = await db.insert(savingsPlans).values({
      reference: `SAV-TEST-${unique}`,
      clientOperationId: `SAV-TEST-OP-${unique}`,
      userId: customer.id,
      financingWalletId: financingWallet.id,
      principalAmount: "1000.00",
      currency: "EGP",
      frequency: "daily",
      ratePercent: "0.0548",
      ratePpm: 548,
      feeAmount: "1.00",
      status: "active",
      startAt: createdAt,
      nextPayoutAt: dueAt,
      totalAccrued: "0.0000",
      totalPaid: "0.00",
    }).$returningId();
    fixture = { customerId: customer.id, adminId: admin.id, planId: plan.id, financingWalletId: financingWallet.id };

    const [first, second] = await Promise.all([
      processAutomaticSavingsPayouts(now),
      processAutomaticSavingsPayouts(now),
    ]);
    expect(first.processed + second.processed).toBe(1);
    expect(first.failed + second.failed).toBe(0);
    expect(first.blocked + second.blocked).toBe(0);

    const [savedWallet] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.userId, customer.id));
    const [savedFinancing] = await db.select({ balance: savingsFinancingWallets.balance }).from(savingsFinancingWallets).where(eq(savingsFinancingWallets.id, financingWallet.id));
    const [savedPlan] = await db.select().from(savingsPlans).where(eq(savingsPlans.id, plan.id));
    const payouts = await db.select({ id: savingsPayouts.id }).from(savingsPayouts).where(eq(savingsPayouts.planId, plan.id));
    const profitTransactions = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.userId, customer.id), eq(transactions.source, "savings_profit")));
    const ledgerEntries = await db.select({ id: cashLedger.id }).from(cashLedger).where(and(eq(cashLedger.userId, customer.id), eq(cashLedger.source, "savings_profit")));
    const financingEntries = await db.select({ id: savingsFinancingEntries.id }).from(savingsFinancingEntries).where(eq(savingsFinancingEntries.savingsPlanId, plan.id));
    const savedNotifications = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "savings")));

    expect(savedWallet?.balance).toBe("0.55");
    expect(savedFinancing?.balance).toBe("99.45");
    expect(savedPlan?.totalPaid).toBe("0.55");
    expect(savedPlan?.nextPayoutAt?.toISOString()).toBe("2026-11-11T09:30:00.000Z");
    expect(payouts).toHaveLength(1);
    expect(profitTransactions).toHaveLength(1);
    expect(ledgerEntries).toHaveLength(1);
    expect(financingEntries).toHaveLength(1);
    expect(savedNotifications).toHaveLength(1);
  });
});
