import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerPaymentMethodAccess, users } from "../drizzle/schema";
import { ADMIN_EMAIL } from "../shared/admin";
import { getCustomerPaymentMethodAccess, getPaymentMethods, setCustomerPaymentMethodDirection } from "../server/payment-settings";
import { getDb } from "../server/db";

const TEST_CUSTOMER_EMAIL = `flotex-payment-access-test-${Date.now()}@example.test`;
let fixture: { customerId: number; adminId: number } | null = null;

function assertIsIsolatedLocalDatabase() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for local payment integration tests.");
  const database = new URL(rawUrl);
  if (database.hostname !== "127.0.0.1" || !database.pathname.startsWith("/flotex_test_")) {
    throw new Error("Refusing payment integration test: DATABASE_URL must target a loopback-only flotex_test_* database.");
  }
}

beforeAll(() => assertIsIsolatedLocalDatabase());

afterEach(async () => {
  if (!fixture) return;
  const db = await getDb();
  if (!db) throw new Error("The isolated local MariaDB connection is unavailable during fixture cleanup.");
  await db.delete(customerPaymentMethodAccess).where(eq(customerPaymentMethodAccess.userId, fixture.customerId));
  await db.delete(users).where(eq(users.id, fixture.customerId));
  await db.delete(users).where(eq(users.id, fixture.adminId));
  fixture = null;
});

describe("customer payment directions on isolated local MariaDB", () => {
  it("changes deposit and withdrawal access independently for one method", async () => {
    assertIsIsolatedLocalDatabase();
    const db = await getDb();
    if (!db) throw new Error("The isolated local MariaDB connection is unavailable.");
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) throw new Error("Refusing payment integration test because the isolated test database contains a user.");

    const createdAt = new Date();
    const unique = Date.now().toString();
    await db.insert(users).values([
      {
        openId: `payment-access-user:${unique}`,
        customerId: unique.slice(-10).padStart(10, "0"),
        name: "عميل اختبار الدفع المحلي",
        email: TEST_CUSTOMER_EMAIL,
        emailNormalized: TEST_CUSTOMER_EMAIL,
        role: "user",
        status: "active",
        deletedAt: null,
        lastSignedIn: createdAt,
      },
      {
        openId: `payment-access-admin:${unique}`,
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
    if (!customer || !admin) throw new Error("Could not create synthetic local payment accounts.");
    fixture = { customerId: customer.id, adminId: admin.id };

    expect((await getPaymentMethods(customer.id, false, "deposit")).some((method) => method.id === "vodafone")).toBe(true);
    expect((await getPaymentMethods(customer.id, false, "withdrawal")).some((method) => method.id === "vodafone")).toBe(true);

    await setCustomerPaymentMethodDirection(admin.id, customer.id, "vodafone", "deposit", false);
    expect((await getPaymentMethods(customer.id, false, "deposit")).some((method) => method.id === "vodafone")).toBe(false);
    expect((await getPaymentMethods(customer.id, false, "withdrawal")).some((method) => method.id === "vodafone")).toBe(true);

    await setCustomerPaymentMethodDirection(admin.id, customer.id, "vodafone", "withdrawal", false);
    await setCustomerPaymentMethodDirection(admin.id, customer.id, "vodafone", "deposit", true);
    expect((await getPaymentMethods(customer.id, false, "deposit")).some((method) => method.id === "vodafone")).toBe(true);
    expect((await getPaymentMethods(customer.id, false, "withdrawal")).some((method) => method.id === "vodafone")).toBe(false);
    expect((await getCustomerPaymentMethodAccess(admin.id, customer.id)).methods).toContainEqual({
      methodId: "vodafone",
      depositEnabled: true,
      withdrawalEnabled: false,
    });
  });
});
