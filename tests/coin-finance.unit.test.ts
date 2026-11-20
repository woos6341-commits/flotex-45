import { beforeEach, describe, expect, it, vi } from "vitest";
import { coinLedgerEntries, coinOrders, coinPriceAudits, coinSettings, coinTransfers, coinTreasuries, coinWallets, notifications, transactions, users, wallets } from "../drizzle/schema";
import { FinanceMemoryDb } from "./helpers/finance-memory-db";
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("../server/db", () => ({ getDb: async () => state.db }));
vi.mock("../server/payment-settings", () => ({ requireAdministrator: async (id: number) => { if (id !== 99) throw Error("approved admin only"); return state.db; } }));
vi.mock("../server/push", () => ({ sendPushOnce: vi.fn(async () => ({ sent: 0 })) }));
vi.mock("../server/security-pin", () => ({ requireValidSecurityPin: vi.fn(async () => undefined) }));
import { adjustUserCoinBalance, cancelCoinOrder, createCoinOrder, createCoinTransfer, fundCoinSales, getAdminCustomerCoinDetails, getCoinOverview, recordCoinInventory, reviewCoinOrder, reviewCoinTransfer, updateCoinSettings } from "../server/coin";
import { sendPushOnce } from "../server/push";
let db: FinanceMemoryDb;
const buy = (key = "test-buy-key-001", quantity = "2") => createCoinOrder(1, { side: "buy", quantity, idempotencyKey: key, securityPin: "1234" });
const sell = (key = "test-sell-key-001", quantity = "2") => createCoinOrder(1, { side: "sell", quantity, idempotencyKey: key, securityPin: "1234" });
const send = (key = "test-send-key-001", quantity = "2") => createCoinTransfer(1, { recipientCustomerId: "1000000002", quantity, idempotencyKey: key, securityPin: "1234" });
beforeEach(() => {
  db = new FinanceMemoryDb(); state.db = db; vi.mocked(sendPushOnce).mockReset().mockResolvedValue({ sent: 0 } as any);
  db.seed(users, [{ id: 1, customerId: "1000000001", name: "Synthetic sender", role: "user", status: "active" }, { id: 2, customerId: "1000000002", name: "Synthetic recipient", role: "user", status: "active" }]);
  db.seed(wallets, [{ id: 1, userId: 1, balance: "1000.00", reservedOrders: "0.00", reservedWithdrawals: "0.00", reservedTransfers: "0.00", reservedSavings: "0.00" }]);
  db.seed(coinWallets, [{ id: 1, userId: 1, balance: "10.000000", reserved: "0.000000" }, { id: 2, userId: 2, balance: "1.000000", reserved: "0.000000" }]);
});
describe("coin finance service without any customer database", () => {
  it("reserves a buy without changing final balances, retries exactly once and uses locking current reads", async () => {
    const first = await buy(); const duplicate = await buy();
    expect(first.order.status).toBe("pending"); expect(duplicate.duplicate).toBe(true);
    expect(db.rows(wallets)[0]).toMatchObject({ balance: "1000.00", reservedOrders: "101.00" });
    expect(db.rows(coinWallets)[0].balance).toBe("10.000000");
    expect(db.rows(coinOrders)).toHaveLength(1); expect(db.rows(coinLedgerEntries)).toHaveLength(0);
    expect(db.calls.find(call => call.table === "coin_orders" && call.kind === "select")?.lock).toBe("update");
    expect(db.calls.some(call => call.table === "coin_settings" && call.lock === "update")).toBe(true);
  });
  it("rejects another owner, side or quantity replay without disclosing an order", async () => {
    await buy();
    for (const input of [{ userId: 2, side: "buy", quantity: "2" }, { userId: 1, side: "sell", quantity: "2" }, { userId: 1, side: "buy", quantity: "3" }] as const) {
      await expect(createCoinOrder(input.userId, { ...input, idempotencyKey: "test-buy-key-001", securityPin: "1234" })).rejects.toThrow("مختلف");
    }
    expect(db.rows(coinOrders)).toHaveLength(1);
  });
  it("approves a buy once, debits EGP and credits the actual user coin ledger instead of treasury debit", async () => {
    const { order } = await buy(); await reviewCoinOrder(99, order.id, "approved"); await reviewCoinOrder(99, order.id, "approved");
    expect(db.rows(wallets)[0]).toMatchObject({ balance: "899.00", reservedOrders: "0.00" });
    expect(db.rows(coinWallets)[0].balance).toBe("12.000000");
    expect(db.rows(transactions)).toHaveLength(1);
    expect(db.rows(coinLedgerEntries).filter(row => row.userId === 1)).toEqual([expect.objectContaining({ kind: "trade", direction: "credit", quantity: "2.000000", balanceAfterQuantity: "12.000000", balanceAfterAmount: "899.00" })]);
    expect(db.rows(coinTreasuries)[0]).toMatchObject({ totalCoins: "98.000000", availableCoins: "98.000000", reservedCoins: "0.000000", buyCashBalance: "101.00" });
  });
  it("reserves and approves a sell exactly once with net proceeds after fees", async () => {
    const { order } = await sell(); expect(db.rows(coinWallets)[0]).toMatchObject({ balance: "10.000000", reserved: "2.000000" });
    expect(db.rows(wallets)[0].balance).toBe("1000.00");
    await reviewCoinOrder(99, order.id, "approved"); await reviewCoinOrder(99, order.id, "approved");
    expect(db.rows(coinWallets)[0]).toMatchObject({ balance: "8.000000", reserved: "0.000000" });
    expect(db.rows(wallets)[0].balance).toBe("1099.00");
    expect(db.rows(coinLedgerEntries).find(row => row.kind === "trade")).toMatchObject({ direction: "debit", balanceAfterQuantity: "8.000000" });
  });
  it.each(["buy", "sell"] as const)("rejecting or cancelling %s releases only its reservation without fees", async side => {
    const { order } = await (side === "buy" ? buy() : sell());
    await cancelCoinOrder(1, order.id); await cancelCoinOrder(1, order.id);
    expect(db.rows(wallets)[0]).toMatchObject({ balance: "1000.00", reservedOrders: "0.00" });
    expect(db.rows(coinWallets)[0]).toMatchObject({ balance: "10.000000", reserved: "0.000000" });
    const second = await createCoinOrder(1, { side, quantity: "2", idempotencyKey: "test-second-order", securityPin: "1234" });
    await reviewCoinOrder(99, second.order.id, "rejected", "reason");
    expect(db.rows(coinLedgerEntries)).toHaveLength(0);
  });
  it("fails closed on corrupted reservation rather than zero-clamping or making balances negative", async () => {
    const { order } = await sell(); db.rows(coinWallets)[0].reserved = "0.000000";
    await expect(reviewCoinOrder(99, order.id, "approved")).rejects.toThrow("حجز");
    await expect(cancelCoinOrder(1, order.id)).rejects.toThrow("حجز");
    expect(db.rows(coinOrders)[0].status).toBe("pending");
  });
  it("reservations cannot double-spend on concurrent buys", async () => {
    db.rows(wallets)[0].balance = "101.00";
    const results = await Promise.allSettled([buy("test-concurrent-a"), buy("test-concurrent-b")]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(db.rows(coinOrders)).toHaveLength(1);
  });
  it("reserves a send then transfers actual quantities and two ledger entries only once after approval", async () => {
    const { transfer } = await send(); await send();
    expect(db.rows(coinWallets)[0]).toMatchObject({ balance: "10.000000", reserved: "2.000000" });
    expect(db.rows(coinWallets)[1].balance).toBe("1.000000");
    await reviewCoinTransfer(99, transfer.id, "approved"); await reviewCoinTransfer(99, transfer.id, "approved");
    expect(db.rows(coinWallets)[0]).toMatchObject({ balance: "8.000000", reserved: "0.000000" });
    expect(db.rows(coinWallets)[1].balance).toBe("3.000000");
    expect(db.rows(coinLedgerEntries)).toHaveLength(2);
    expect(db.rows(coinLedgerEntries).map(row => row.direction)).toEqual(["debit", "credit"]);
  });
  it("rejects a send replay with changed quantity and releases rejection reservations once", async () => {
    const { transfer } = await send(); await expect(send("test-send-key-001", "3")).rejects.toThrow("مختلف");
    await reviewCoinTransfer(99, transfer.id, "rejected"); await reviewCoinTransfer(99, transfer.id, "rejected");
    expect(db.rows(coinWallets)[0].reserved).toBe("0.000000"); expect(db.rows(coinLedgerEntries)).toHaveLength(0);
  });
  it("rolls back money and notices when ledger persistence fails; push starts only after commit", async () => {
    const { order } = await buy(); vi.mocked(sendPushOnce).mockClear(); db.failInsertTable = "coin_ledger_entries";
    await expect(reviewCoinOrder(99, order.id, "approved")).rejects.toThrow("persistence");
    expect(db.rows(wallets)[0].balance).toBe("1000.00"); expect(db.rows(coinOrders)[0].status).toBe("pending");
    expect(sendPushOnce).not.toHaveBeenCalled();
    db.failInsertTable = null; vi.mocked(sendPushOnce).mockImplementation(async () => { expect(db.inTransaction).toBe(false); throw Error("push offline"); });
    await expect(reviewCoinOrder(99, order.id, "approved")).resolves.toBeTruthy();
    expect(db.rows(notifications)).toHaveLength(2);
  });
  it("admin coin adjustment respects reservations, replays unchanged and rejects changed payload", async () => {
    db.rows(coinWallets)[0].reserved = "8.000000";
    await expect(adjustUserCoinBalance(99, 1, "-3", "synthetic reason", "test-adjust-key")).rejects.toThrow("المتاح");
    await adjustUserCoinBalance(99, 1, "-2", "synthetic reason", "test-adjust-key");
    expect((await adjustUserCoinBalance(99, 1, "-2", "synthetic reason", "test-adjust-key")).duplicate).toBe(true);
    await expect(adjustUserCoinBalance(99, 1, "-1", "synthetic reason", "test-adjust-key")).rejects.toThrow("مختلف");
    expect(db.rows(coinWallets)[0].balance).toBe("8.000000");
    await expect(adjustUserCoinBalance(1, 1, "1", "synthetic reason", "test-other-key")).rejects.toThrow("admin");
  });
  it("price decreases/increases create exact notices for customers, fee-only or unchanged save does not", async () => {
    const input = { buyPrice: "45.00", sellPrice: "55.00", buyFee: "1.00", sellFee: "1.00", transferMinimum: "2", buyFeeEnabled: true, sellFeeEnabled: true };
    await updateCoinSettings(99, input);
    expect(db.rows(notifications).map(row => row.title)).toEqual(["تم خفض سعر الكوين", "تم خفض سعر الكوين", "تم زيادة سعر الكوين", "تم زيادة سعر الكوين"]);
    await updateCoinSettings(99, { ...input, buyFee: "2.00" });
    expect(db.rows(notifications)).toHaveLength(4); expect(db.rows(coinPriceAudits)).toHaveLength(1);
  });
  it("dossier paginates all orders and exposes actual coin wallet, excluding historic treasury rows", async () => {
    db.seed(coinOrders, Array.from({ length: 17 }, (_, index) => ({ id: index + 1, userId: 1, reference: `old-${index}`, quantity: "1.000000" })));
    db.seed(coinLedgerEntries, [{ id: 1, userId: 1, kind: "inventory", quantity: "9.000000" }, { id: 2, userId: 1, kind: "admin_adjustment", quantity: "1.000000" }]);
    const details = await getAdminCustomerCoinDetails(99, 1, 0, 15);
    expect(details.wallet).toMatchObject({ balance: "10.000000", reserved: "0.000000", available: "10.000000" });
    expect(details.orders).toMatchObject({ total: 17, hasMore: true }); expect(details.ledger.items).toHaveLength(1);
    expect((await getAdminCustomerCoinDetails(99, 1, 15, 15)).orders.items).toHaveLength(2);
    expect(db.calls.some(row => row.kind === "insert" || row.kind === "update")).toBe(false);
  });
  it.each(["0", "0.0000001", "1e2", "NaN", "Infinity", "1000000001"])("rejects invalid quantity %s before financial writes", async raw => {
    await expect(buy("test-invalid-key", raw)).rejects.toThrow();
    expect(db.rows(coinOrders)).toHaveLength(0);
  });
  it("inventory and funding keep exactly-once balances and reject cross-operation key reuse", async () => {
    const inventory = { quantity: "1", source: "synthetic", direction: "credit" as const, idempotencyKey: "test-inventory-key" };
    await recordCoinInventory(99, inventory); expect((await recordCoinInventory(99, inventory)).duplicate).toBe(true);
    expect(db.rows(coinTreasuries)[0].totalCoins).toBe("101.000000");
    await expect(fundCoinSales(99, { amount: "1", source: "synthetic", idempotencyKey: inventory.idempotencyKey })).rejects.toThrow("مختلف");
  });
});
