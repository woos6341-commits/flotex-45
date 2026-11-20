import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb } from "../server/db";
import { updateOwnNationalId } from "../server/profile-data";

const testOpenIds: string[] = [];

function assertIsolatedLocalDatabase() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for the local national-ID integration test.");
  const database = new URL(rawUrl);
  if (database.hostname !== "127.0.0.1" || !database.pathname.startsWith("/flotex_test_")) {
    throw new Error("Refusing national-ID integration test: use a loopback-only flotex_test_* database.");
  }
}

function validSyntheticNationalId(serial: string) {
  const body = `290010101${serial.padStart(4, "0")}`;
  const weights = [2, 7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(body[index]) * weight, 0);
  return `${body}${(11 - sum % 11) % 10}`;
}

async function createUsers(count: number) {
  const db = await getDb();
  if (!db) throw new Error("The isolated local MySQL connection is unavailable.");
  const marker = randomUUID();
  const rows = Array.from({ length: count }, (_, index) => ({
    openId: `national-id-test:${marker}:${index}`,
    customerId: `${Date.now().toString().slice(-8)}${String(index + 1).padStart(2, "0")}`,
    name: "حساب اصطناعي لاختبار التفرد",
    email: `national-id-${marker}-${index}@example.test`,
    emailNormalized: `national-id-${marker}-${index}@example.test`,
    role: "user" as const,
    status: "active" as const,
    deletedAt: null,
    lastSignedIn: new Date(),
  }));
  testOpenIds.push(...rows.map((row) => row.openId));
  await db.insert(users).values(rows);
  const created = await db.select({ id: users.id, openId: users.openId }).from(users);
  const selected = created.filter((row) => testOpenIds.includes(row.openId));
  if (selected.length !== count) throw new Error("Could not create isolated synthetic accounts.");
  return selected.sort((a, b) => a.openId.localeCompare(b.openId));
}

afterEach(async () => {
  const db = await getDb();
  if (!db || !testOpenIds.length) return;
  for (const openId of testOpenIds.splice(0)) await db.delete(users).where(eq(users.openId, openId));
});

describe("unique national-ID fingerprint on isolated local MySQL", () => {
  it("normalizes the submitted ID and refuses reuse by a second account", async () => {
    assertIsolatedLocalDatabase();
    const db = await getDb();
    if (!db) throw new Error("The isolated local MySQL connection is unavailable.");
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) throw new Error("Refusing national-ID test because the local test database is not empty.");
    const [first, second] = await createUsers(2);
    const id = validSyntheticNationalId("0021");
    const arabicDigits = id.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
    await expect(updateOwnNationalId(first!.id, id)).resolves.toMatchObject({ nationalIdMasked: `**********${id.slice(-4)}` });
    await expect(updateOwnNationalId(second!.id, arabicDigits)).rejects.toThrow("مستخدم بالفعل في حساب آخر");
    const stored = await db.select({ fingerprint: users.nationalIdFingerprint }).from(users).where(eq(users.id, first!.id));
    expect(stored[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the unique index effective when two new accounts race with the same ID", async () => {
    assertIsolatedLocalDatabase();
    const [first, second] = await createUsers(2);
    const id = validSyntheticNationalId("0022");
    const results = await Promise.allSettled([
      updateOwnNationalId(first!.id, id),
      updateOwnNationalId(second!.id, id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
