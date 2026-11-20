import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { gameTopupRequests, users } from "../drizzle/schema";

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock("../server/db", () => ({ getDb: async () => state.db }));
import { listAdminGameTopupRequests } from "../server/game-topup";
import { getRecentOperations } from "../server/recent-operations";

const statuses = ["new", "under_review", "approved", "processing", "completed", "rejected", "cancelled"] as const;
const active = statuses.slice(0, 4);
const reviewedAt = new Date("2026-01-02T12:00:00Z");
const fixtures = statuses.map((status, index) => ({
  id: index + 1, reference: `FAKE-GAME-${index}`, userId: 41, gameId: 5, gameName: "Game", kind: ["topup", "deposit", "withdraw"][index % 3],
  quantity: 60, unitPrice: "1.0000", subtotalAmount: "60.00", feeAmount: "0.00", totalAmount: "60.00", playerDataJson: "[]",
  status, createdAt: new Date(`2026-01-${String(index + 3).padStart(2, "0")}T00:00:00Z`), updatedAt: reviewedAt,
  reviewedAt: index >= 2 ? reviewedAt : null, reviewedBy: index >= 2 ? 9 : null,
}));
const dialect = new MySqlDialect();
function fakeDb() {
  return {
    select(selection: any = {}) {
      let table: unknown, condition: any, take = Infinity, skip = 0;
      const chain: any = {
        from(value: unknown) { table = value; return chain; },
        leftJoin() { return chain; },
        where(value: any) { condition = value; return chain; },
        orderBy() { return chain; },
        limit(value: number) { take = value; return chain; },
        offset(value: number) { skip = value; return chain; },
        then(resolve: any, reject: any) {
          try {
            if (table === users) return Promise.resolve([{ id: 9, name: "مدير وهمي", email: "admin@example.test", role: "admin" }]).then(resolve, reject);
            if (table !== gameTopupRequests) return Promise.resolve([]).then(resolve, reject);
            const query = condition ? dialect.sqlToQuery(condition) : { sql: "", params: [] };
            const selectedStatuses = statuses.filter((status) => query.params.includes(status));
            let rows = fixtures.filter((row) => !selectedStatuses.length || (/not in/i.test(query.sql) ? !selectedStatuses.includes(row.status) : selectedStatuses.includes(row.status)));
            if ("total" in selection) return Promise.resolve([{ total: rows.length }]).then(resolve, reject);
            rows = rows.slice(skip, skip + take);
            return Promise.resolve(rows.map((row) => "request" in selection
              ? { request: row, user: { name: "عميل وهمي", customerId: "123" }, currencyLabel: "شدة" }
              : { row, customer: { name: "عميل وهمي", customerId: "123" } })).then(resolve, reject);
          } catch (error) { return Promise.reject(error).then(resolve, reject); }
        },
      };
      return chain;
    },
  };
}

describe("game tracking using a read-only fake DB", () => {
  it("uses the same active lifecycle for the specialist list and unified queue", async () => {
    state.db = fakeDb();
    const list = await listAdminGameTopupRequests({ status: "pending" });
    expect(list.requests.map((request) => request.status)).toEqual(active);
    expect(list.total).toBe(4);
    const page = await listAdminGameTopupRequests({ status: "pending", offset: 2, limit: 1 });
    expect(page.requests.map((request) => request.status)).toEqual(["approved"]);
    expect(page.total).toBe(4);
    const queue = await getRecentOperations({ pendingOnly: true, section: "gameTopup", limit: 100 });
    expect(queue.map((request) => request.status)).toEqual(active);
    expect(queue.every((request) => request.pending)).toBe(true);
    expect(queue.find((request) => request.status === "approved")).toMatchObject({ decisionByName: "مدير وهمي", decisionAt: reviewedAt.toISOString() });
    const history = await getRecentOperations({ historyOnly: true, section: "gameTopup", limit: 100 });
    expect(history.map((request) => request.status)).toEqual(["completed", "rejected", "cancelled"]);
    expect(history[0]).toMatchObject({ decisionByName: "مدير وهمي", decisionAt: reviewedAt.toISOString(), pending: false });
  });

  it("preserves existing specialist decision archive and explicit status filters", async () => {
    state.db = fakeDb();
    const archive = await listAdminGameTopupRequests({ status: "archive" });
    expect(archive.requests.map((request) => request.status)).toEqual(["approved", "processing", "completed", "rejected", "cancelled"]);
    for (const status of statuses) {
      const result = await listAdminGameTopupRequests({ status });
      expect(result.requests.map((request) => request.status)).toEqual([status]);
      expect(result.total).toBe(1);
    }
  });
});
