import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ADMIN_EMAIL } from "../shared/admin";
import { DEFAULT_HOME_ACTION_ORDER } from "../shared/home-action-order";
import { appSettings, users } from "../drizzle/schema";
import { getDb, getUserByOpenId, upsertUser } from "../server/db";
import { getHomeActionOrder, getHomeActionOrderForUser, resetCustomerHomeActionOrder, setCustomerHomeActionOrder } from "../server/home-action-order";

const isolatedIt = process.env.FLOTEX_ISOLATED_TEST_DB === "1" ? it : it.skip;
const userIds: number[] = [];
let personalOrderKey: string | null = null;

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  if (personalOrderKey) await db.delete(appSettings).where(eq(appSettings.key, personalOrderKey));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

describe("per-customer home action ordering on isolated local DB", () => {
  isolatedIt("saves an individual order, leaves the global order unchanged, and resets to inheritance", async () => {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) throw new Error("DATABASE_URL is required for the isolated order test.");
    const target = new URL(rawUrl);
    if (target.hostname !== "127.0.0.1" || !target.pathname.startsWith("/flotex_test_")) {
      throw new Error("Refusing personal-order test outside a loopback flotex_test_* database.");
    }
    const suffix = randomUUID();
    const adminOpenId = `personal-order-admin:${suffix}`;
    const userOpenId = `personal-order-user:${suffix}`;
    await upsertUser({ openId: adminOpenId, name: "مسؤول اختبار الترتيب", role: "admin", email: ADMIN_EMAIL, loginMethod: "test" });
    await upsertUser({ openId: userOpenId, name: "عميل اختبار الترتيب", loginMethod: "test" });
    const admin = await getUserByOpenId(adminOpenId);
    const customer = await getUserByOpenId(userOpenId);
    if (!admin || !customer) throw new Error("Could not create isolated home-order fixtures.");
    userIds.push(admin.id, customer.id);
    personalOrderKey = `home_action_order_user_v1:${customer.id}`;

    const globalBefore = await getHomeActionOrder();
    expect(await getHomeActionOrderForUser(customer.id)).toEqual(globalBefore);
    const personal = ["savings", "withdrawal", "transfer", "deposit"] as const;
    const saved = await setCustomerHomeActionOrder(admin.id, customer.id, personal);
    expect(saved).toMatchObject({ order: personal, inherited: false });
    expect(await getHomeActionOrderForUser(customer.id)).toEqual(personal);
    expect(await getHomeActionOrder()).toEqual(globalBefore);

    const reset = await resetCustomerHomeActionOrder(admin.id, customer.id);
    expect(reset).toMatchObject({ order: globalBefore, inherited: true });
    expect(await getHomeActionOrderForUser(customer.id)).toEqual(globalBefore);
    expect(DEFAULT_HOME_ACTION_ORDER).toHaveLength(4);
  });
});
