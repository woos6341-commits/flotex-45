import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gameTopupGames,
  gameTopupRequests,
  gameTopupSettings,
  notifications,
  transactions,
  users,
  wallets,
} from "../drizzle/schema";

const state = vi.hoisted(() => ({
  db: null as any,
  getDbCalls: 0,
  transactionCalls: 0,
  requestSelectCalls: 0,
  userSelectCalls: 0,
  requestLockCount: 0,
  request: null as any,
  wallet: null as any,
  ledger: [] as any[],
  notices: [] as any[],
  settings: null as any,
  game: null as any,
}));

vi.mock("../server/db", () => ({
  getDb: async () => {
    state.getDbCalls += 1;
    return state.db;
  },
}));

import { createGameWithdrawRequest, reviewGameTopupRequest } from "../server/game-topup";

function rowsFor(table: unknown) {
  if (table === users) {
    state.userSelectCalls += 1;
    return state.userSelectCalls === 1
      ? [{ id: 41, status: "active" }]
      : [{ id: 9 }];
  }
  if (table === gameTopupRequests) {
    state.requestSelectCalls += 1;
    return state.requestSelectCalls === 1 || !state.request ? [] : [state.request];
  }
  if (table === gameTopupSettings) return state.settings ? [state.settings] : [];
  if (table === gameTopupGames) return state.game ? [state.game] : [];
  if (table === wallets) return state.wallet ? [state.wallet] : [];
  return [];
}

function makeSelectBuilder() {
  let table: unknown;
  const builder: any = {
    from(value: unknown) { table = value; return builder; },
    where() { return builder; },
    for(mode: string) {
      if (mode === "update" && table === gameTopupRequests) state.requestLockCount += 1;
      return builder;
    },
    limit() { return Promise.resolve(rowsFor(table)); },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
      return Promise.resolve(rowsFor(table)).then(resolve, reject);
    },
  };
  return builder;
}

function makeDatabase() {
  const tx = {
    select: () => makeSelectBuilder(),
    insert(table: unknown) {
      return {
        values(values: any) {
          if (table === gameTopupRequests) {
            const now = new Date();
            state.request = {
              id: 71,
              ...values,
              adminNote: values.adminNote ?? null,
              rejectionReason: values.rejectionReason ?? null,
              providerReference: values.providerReference ?? null,
              createdAt: now,
              updatedAt: now,
              reviewedAt: null,
              completedAt: null,
            };
            return Promise.resolve({ insertId: 71 });
          }
          if (table === transactions) {
            state.ledger.push(values);
            return Promise.resolve({ insertId: state.ledger.length });
          }
          if (table === notifications) state.notices.push(values);
          return {
            onDuplicateKeyUpdate: async () => ({ affectedRows: 1 }),
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: async () => {
              if (table === wallets) state.wallet = { ...state.wallet, ...values };
              if (table === gameTopupRequests) state.request = { ...state.request, ...values };
              return [{ affectedRows: 1 }];
            },
          };
        },
      };
    },
  };
  let transactionTail: Promise<unknown> = Promise.resolve();
  return {
    transaction<T>(callback: (transaction: typeof tx) => Promise<T>) {
      state.transactionCalls += 1;
      const result = transactionTail.then(() => callback(tx));
      transactionTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

function resetState() {
  state.getDbCalls = 0;
  state.transactionCalls = 0;
  state.requestSelectCalls = 0;
  state.userSelectCalls = 0;
  state.requestLockCount = 0;
  state.request = null;
  state.wallet = {
    id: 22,
    userId: 41,
    balance: "30.00",
    reservedOrders: "0.00",
    reservedWithdrawals: "0.00",
    reservedTransfers: "0.00",
    reservedSavings: "0.00",
    currency: "EGP",
  };
  state.ledger = [];
  state.notices = [];
  state.settings = { id: 1, enabled: true };
  state.game = {
    id: 9,
    serviceType: "deposit_withdraw",
    name: "1xBet",
    isActive: true,
    withdrawEnabled: true,
    minWithdrawAmount: "50.00",
    cityValue: "Cairo",
    streetValue: "Main street",
    userIdFieldLabel: "ID المستخدم",
    cityLabel: "المدينة",
    streetLabel: "الشارع",
    withdrawalCodeLabel: "كود السحب",
  };
  state.db = makeDatabase();
}

describe("1xBet withdrawal submission and review (isolated in-memory transaction)", () => {
  beforeEach(resetState);

  it("requires a player ID and withdrawal code before opening a database transaction", async () => {
    const key = "withdrawal-request-operation-001";
    await expect(createGameWithdrawRequest(41, {
      gameId: 9,
      amount: "125.50",
      userGameId: " ",
      withdrawalCode: "CODE-77",
      idempotencyKey: key,
    })).rejects.toThrow("أدخل ID المستخدم في 1xBet بشكل صحيح");
    await expect(createGameWithdrawRequest(41, {
      gameId: 9,
      amount: "125.50",
      userGameId: "player-123",
      withdrawalCode: " ",
      idempotencyKey: key,
    })).rejects.toThrow("أدخل كود السحب بشكل صحيح");
    expect(state.getDbCalls).toBe(0);
    expect(state.transactionCalls).toBe(0);
  });

  it("stores the withdrawal details and credits the wallet exactly once after approval", async () => {
    const submitted = await createGameWithdrawRequest(41, {
      gameId: 9,
      amount: "125.50",
      userGameId: "player-123",
      withdrawalCode: "CODE-77",
      idempotencyKey: "withdrawal-request-operation-002",
    });

    expect(submitted.request.playerData).toEqual(expect.arrayContaining([
      { key: "userId", label: "ID المستخدم", value: "player-123" },
      { key: "withdrawalCode", label: "كود السحب", value: "CODE-77" },
    ]));
    expect(submitted.request.status).toBe("new");
    expect(state.wallet.balance).toBe("30.00");
    expect(state.ledger).toHaveLength(0);

    const [approved, repeatedApproval] = await Promise.all([
      reviewGameTopupRequest(9, { requestId: submitted.request.id, status: "approved" }),
      reviewGameTopupRequest(9, { requestId: submitted.request.id, status: "approved" }),
    ]);

    expect(approved.duplicate).toBe(false);
    expect(approved.request.status).toBe("approved");
    expect(repeatedApproval.duplicate).toBe(true);
    expect(repeatedApproval.request.status).toBe("approved");
    expect(state.requestLockCount).toBe(2);
    expect(state.wallet.balance).toBe("155.50");
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      userId: 41,
      type: "adjustment",
      amount: "125.50",
      currency: "EGP",
      status: "approved",
      direction: "credit",
      source: "game_topup",
      balanceBefore: "30.00",
      balanceAfter: "155.50",
      customerTitle: "سحب 1xBet",
    });
    expect(state.request).toMatchObject({
      status: "approved",
      reviewedBy: 9,
      reviewedAt: expect.any(Date),
    });
  });
});
