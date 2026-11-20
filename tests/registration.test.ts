import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { notifications, users, wallets } from "../drizzle/schema";
import {
  getDb,
  upsertUser,
  getUserByOpenId,
  updateProfileName,
  ensureWallet,
} from "../server/db";
import {
  completeRegistration,
  PROFILE_LOCKED_MESSAGE,
} from "../server/registration";
import {
  registrationSchema,
  normalizePhoneNumber,
} from "../shared/registration";
import { appRouter } from "../server/routers";
import type { TrpcContext } from "../server/_core/context";
const created: number[] = [];
const prefix = `profile-test-${randomUUID().slice(0, 10)}`;
const input = {
  givenName: "أحمد",
  fatherName: "محمود",
  phoneNumber: "01012345678",
  birthDate: "1990-01-31",
};
function inputForUser(userId: number) {
  return {
    ...input,
    phoneNumber: `010${String(userId).padStart(8, "0").slice(-8)}`,
  };
}
async function createCustomer(label: string) {
  const openId = `${prefix}-${label}`;
  await upsertUser({
    openId,
    name: "اسم الدخول القديم",
    email: `${openId}@example.test`,
    loginMethod: "test",
  });
  const user = (await getUserByOpenId(openId))!;
  created.push(user.id);
  await ensureWallet(user.id);
  return user;
}
let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
beforeAll(async () => {
  db = (await getDb())!;
}, 30000);
afterAll(async () => {
  if (!created.length) return;
  await db.delete(notifications).where(inArray(notifications.userId, created));
  await db.delete(wallets).where(inArray(wallets.userId, created));
  await db.delete(users).where(inArray(users.id, created));
}, 30000);
describe("registration validation", () => {
  it("requires all identity fields and normalizes Egyptian phones", () => {
    expect(
      registrationSchema.safeParse({ ...input, fatherName: "" }).success,
    ).toBe(false);
    expect(
      registrationSchema.safeParse({ ...input, phoneNumber: "123" }).success,
    ).toBe(false);
    expect(normalizePhoneNumber("+20 1012345678")).toBe("01012345678");
    expect(normalizePhoneNumber("٠١٠١٢٣٤٥٦٧٨")).toBe("01012345678");
  });
});
describe("immutable customer registration", () => {
  it("completes an existing account without touching customer ID or balance and replays safely", async () => {
    const before = await createCustomer("old");
    const userInput = inputForUser(before.id);
    const [walletBefore] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, before.id));
    const saved = await completeRegistration(before.id, userInput);
    expect(saved.customerId).toBe(before.customerId);
    expect(saved.name).toBe("أحمد محمود");
    expect(saved.profileCompletedAt).toBeTruthy();
    const replay = await completeRegistration(before.id, userInput);
    expect(replay.profileCompletedAt).toEqual(saved.profileCompletedAt);
    const [walletAfter] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, before.id));
    expect(walletAfter.balance).toBe(walletBefore.balance);
    const notices = await db
      .select()
      .from(notifications)
      .where(eq(notifications.operationId, `profile:${before.id}`));
    expect(notices).toHaveLength(1);
  }, 30000);
  it("rejects editing names or identity fields after completion and freezes provider email", async () => {
    const user = await createCustomer("locked");
    const userInput = inputForUser(user.id);
    await completeRegistration(user.id, userInput);
    await expect(updateProfileName(user.id, "اسم مختلف")).rejects.toThrow(
      PROFILE_LOCKED_MESSAGE,
    );
    await expect(
      completeRegistration(user.id, { ...userInput, fatherName: "إبراهيم" }),
    ).rejects.toThrow(PROFILE_LOCKED_MESSAGE);
    await upsertUser({
      openId: user.openId,
      name: "OAuth name",
      email: "changed@example.test",
    });
    const read = await getUserByOpenId(user.openId);
    expect(read!.name).toBe("أحمد محمود");
    expect(read!.email).toBe(user.email);
    expect(read!.fatherName).toBe("محمود");
    expect(read!.customerId).toBe(user.customerId);
  }, 30000);
  it("allows only one concurrent profile completion with different fields", async () => {
    const user = await createCustomer("race");
    const userInput = inputForUser(user.id);
    const results = await Promise.allSettled([
      completeRegistration(user.id, userInput),
      completeRegistration(user.id, { ...userInput, phoneNumber: "01112345678" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const notice = await db
      .select()
      .from(notifications)
      .where(eq(notifications.operationId, `profile:${user.id}`));
    expect(notice).toHaveLength(1);
  }, 30000);
  it("uses authenticated user identity, not a client-supplied ID, and gates financial requests", async () => {
    const user = await createCustomer("api");
    const caller = appRouter.createCaller({
      user,
      req: { headers: {}, protocol: "https" },
      res: {},
    } as TrpcContext);
    await expect(
      caller.portfolio.request({
        type: "withdrawal",
        amount: "50.00",
        paymentMethodId: "vodafone",
        operationId: randomUUID(),
        destination: "01012345678",
      }),
    ).rejects.toThrow("أكمل بيانات التسجيل أولًا");
    await expect(
      caller.auth.completeRegistration({ ...input, userId: 999999 } as any),
    ).rejects.toThrow();
    const saved = await caller.auth.completeRegistration(inputForUser(user.id));
    expect(saved.id).toBe(user.id);
    const reread = await getUserByOpenId(user.openId);
    expect(reread!.givenName).toBe("أحمد");
    expect(reread!.customerId).toBe(user.customerId);
  }, 30000);
  it("does not create duplicate rows when the same external account registers concurrently", async () => {
    const openId = `${prefix}-one-account`;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        upsertUser({
          openId,
          email: `${openId}@example.test`,
          name: "عميل جديد",
          loginMethod: "test",
        }),
      ),
    );
    const rows = await db.select().from(users).where(eq(users.openId, openId));
    created.push(rows[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toMatch(/^\d{10}$/);
  }, 30000);
});
