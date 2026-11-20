import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb, getUserByOpenId, upsertUser } from "../server/db";

const ids = Array.from({ length: 5 }, (_, index) => `customer-id-test-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`);

afterEach(async () => {
  const db = await getDb();
  if (db) await db.delete(users).where(inArray(users.openId, ids));
});

describe("customer IDs", () => {
  it("repairs an existing invalid ID and keeps it stable", async () => {
    const db = await getDb();
    await db!.insert(users).values({ openId: ids[0], customerId: "----------", name: "عميل قديم", email: `${ids[0]}@example.test`, loginMethod: "test" });
    await upsertUser({ openId: ids[0], name: "عميل قديم", email: `${ids[0]}@example.test`, loginMethod: "test" });
    const first = await getUserByOpenId(ids[0]);
    expect(first?.customerId).toMatch(/^\d{10}$/);
    const stableId = first!.customerId;
    await upsertUser({ openId: ids[0], name: "عميل قديم محدث", email: `${ids[0]}@example.test`, loginMethod: "test" });
    const second = await getUserByOpenId(ids[0]);
    expect(second?.customerId).toBe(stableId);
  }, 30_000);

  it("creates unique IDs for concurrent registrations", async () => {
    await Promise.all(ids.slice(1).map((openId) => upsertUser({ openId, name: "عميل جديد", email: `${openId}@example.test`, loginMethod: "test" })));
    const db = await getDb();
    const rows = await db!.select({ customerId: users.customerId }).from(users).where(inArray(users.openId, ids.slice(1)));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => /^\d{10}$/.test(row.customerId))).toBe(true);
    expect(new Set(rows.map((row) => row.customerId)).size).toBe(4);
  }, 30_000);
});
