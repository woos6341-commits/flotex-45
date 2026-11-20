import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { adminPaymentRequestById, adminPendingPaymentRequests, adminRequests } from "../server/db";
import { appRouter } from "../server/routers";

// This fixture is deliberately limited to the temporary, loopback-only test server.
const enabled = process.env.FLOTEX_RUN_LOCAL_DB_TESTS === "1" && process.env.FLOTEX_RUN_PAYMENT_REVIEW_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
let connection: mysql.Connection;

describe.runIf(enabled)("payment review queue on isolated synthetic MariaDB", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.port !== "33417" || url.pathname !== "/flotex_test_review") throw new Error("Refusing non-isolated payment review test database");
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
    await connection.query("CREATE TABLE users (id INT PRIMARY KEY, name TEXT, email VARCHAR(320), customerId VARCHAR(10))");
    await connection.query(`CREATE TABLE requests (
      id INT PRIMARY KEY, reference VARCHAR(80), userId INT, type ENUM('deposit','withdrawal'),
      amount DECIMAL(14,2), feeAmount DECIMAL(14,2), currency VARCHAR(8), paymentChannel VARCHAR(40),
      transferReference VARCHAR(150), receiptImageUrl TEXT, destination VARCHAR(180), paymentMethodId VARCHAR(20),
      customFields TEXT, clientOperationId VARCHAR(80), payloadHash VARCHAR(64), senderReference VARCHAR(150),
      submittedTransferReference VARCHAR(150), transferNumberSnapshot VARCHAR(120), payoutReference VARCHAR(150),
      status ENUM('pending','approved','rejected','completed'), note TEXT, rejectionReason TEXT,
      reviewedBy INT, reviewedAt TIMESTAMP NULL, createdAt TIMESTAMP NOT NULL
    )`);
    await connection.query("INSERT INTO users VALUES (1, 'Fixture', 'fixture@example.test', '0000000001')");
    const rows: unknown[][] = [];
    // Identical timestamps deliberately exercise the ID tie-breaker.
    for (let id = 1; id <= 31; id++) rows.push([id, `DEP-${id}`, 1, "deposit", "10.00", "0.00", "EGP", "pending", "2025-01-01 10:00:00", "/private/receipt"]);
    for (let id = 101; id <= 131; id++) rows.push([id, `WDR-${id}`, 1, "withdrawal", "10.00", "0.00", "EGP", "pending", "2025-01-01 10:00:00", null]);
    for (let id = 1001; id <= 1140; id++) rows.push([id, `DONE-${id}`, 1, "deposit", "10.00", "0.00", "EGP", "approved", "2026-01-01 10:00:00", null]);
    await connection.query("INSERT INTO requests (id, reference, userId, type, amount, feeAmount, currency, status, createdAt, receiptImageUrl) VALUES ?", [rows]);
  });
  afterAll(async () => { await connection?.end(); });

  it("returns old pending records rather than the 140 newer finalized ones, independently by type", async () => {
    const legacy = await adminRequests();
    expect(legacy).toHaveLength(62);
    expect(legacy.every((row) => row.request.status === "pending")).toBe(true);
    const deposits = await adminPendingPaymentRequests({ type: "deposit", limit: 25 });
    const withdrawals = await adminPendingPaymentRequests({ type: "withdrawal", limit: 25 });
    expect(deposits.items.map((row) => row.request.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(withdrawals.items.map((row) => row.request.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 101));
    expect(deposits.nextCursor?.id).toBe(25);
    expect(withdrawals.nextCursor?.id).toBe(125);
    expect(deposits.items[0].request).not.toHaveProperty("receiptImageUrl");
    expect(deposits.items[0].request.hasReceipt).toBe(true);
  });

  it("keeps a stable keyset boundary if an earlier request is resolved between pages", async () => {
    const first = await adminPendingPaymentRequests({ type: "deposit", limit: 25 });
    await connection.query("UPDATE requests SET status='approved' WHERE id=1");
    const second = await adminPendingPaymentRequests({ type: "deposit", limit: 25, cursor: first.nextCursor! });
    expect(second.items.map((row) => row.request.id)).toEqual([26, 27, 28, 29, 30, 31]);
    expect(second.nextCursor).toBeNull();
    await connection.query("UPDATE requests SET status='pending' WHERE id=1");
  });

  it("directly finds a selected request outside the first page and a finalized request without leaking receipt paths", async () => {
    const row = await adminPaymentRequestById(31);
    expect(row?.request).toMatchObject({ id: 31, status: "pending", hasReceipt: true });
    expect(row?.request).not.toHaveProperty("receiptImageUrl");
    expect((await adminPaymentRequestById(1001))?.request.status).toBe("approved");
    expect(await adminPaymentRequestById(9999)).toBeNull();
  });

  it("restricts both endpoints to admins, validates cursor input, and marks reads private", async () => {
    const headers = vi.fn();
    const makeCaller = (user: any) => appRouter.createCaller({ req: {} as any, res: { setHeader: headers } as any, user } as any);
    const ordinary = makeCaller({ id: 3, role: "user", email: "customer@example.test" });
    await expect(ordinary.admin.pendingPaymentRequests({ type: "deposit", limit: 25 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ordinary.admin.paymentRequestById({ requestId: 31 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = makeCaller({ id: 9, role: "admin", email: "dyblhwyty@gmail.com" });
    await expect(admin.admin.pendingPaymentRequests({ type: "deposit", limit: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.admin.pendingPaymentRequests({ type: "deposit", limit: 25, cursor: { createdAt: "bad-date", id: 1 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.admin.paymentRequestById({ requestId: 31 })).resolves.toMatchObject({ request: { id: 31 } });
    expect(headers).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});
