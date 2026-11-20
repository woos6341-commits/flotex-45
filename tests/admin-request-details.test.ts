import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { requireAdministrator } from "../server/payment-settings";
import { adminRequestDetailsInputSchema, getAdminRequestDetails, maskedDynamicFields, parseAdminRequestKey, safeRequestText } from "../server/admin-request-details";

vi.mock("../server/payment-settings", () => ({ requireAdministrator: vi.fn() }));

const dialect = new MySqlDialect();
type Fixture = Record<string, any>;
function fakeDb(fixtures: Record<string, Fixture[]>) {
  const calls: { table: string; columns: string[]; sql: string; params: unknown[] }[] = [];
  const db = {
    select(columns: Record<string, any>) {
      let tableName = "", condition: any;
      const chain = {
        from(table: any) { tableName = getTableName(table); return chain; },
        where(value: any) { condition = value; return chain; },
        orderBy(..._args: any[]) { return chain; },
        async limit(count: number) {
          const query = condition ? dialect.sqlToQuery(condition) : { sql: "", params: [] };
          calls.push({ table: tableName, columns: Object.keys(columns), sql: query.sql, params: query.params });
          const where = query.sql;
          const params = query.params as any[];
          let rows = fixtures[tableName] ?? [];
          // These fixtures deliberately share identifiers across different source tables.
          if (where.includes("`id` = ?") && params.length) rows = rows.filter((row) => row.id === params[0]);
          if (tableName === "support_messages" && params.length >= 2) rows = rows.filter((row) => row.userId === params[0] && row.category === params[1]);
          if (tableName === "support_thread_states" && params.length >= 2) rows = rows.filter((row) => row.userId === params[0] && row.category === params[1]);
          if (tableName === "guest_support_messages" || tableName === "guest_support_audit_events") rows = rows.filter((row) => row.ticketId === params[0]);
          return rows.slice(0, count).map((row) => Object.fromEntries(Object.entries(columns).map(([alias, col]) => [alias, alias === "hasReceipt" ? (row.receiptImageUrl ? 1 : 0) : row[col?.name ?? alias] ?? null])));
        },
      };
      return chain;
    },
  };
  return { db, calls };
}
const when = new Date("2026-11-01T12:00:00Z");
const reviewed = new Date("2026-11-02T12:00:00Z");
const users = [
  { id: 10, name: "عميل حقيقي", customerId: "0012345678", role: "user" },
  { id: 11, name: "مستلم", customerId: "0099999999", role: "user" },
  { id: 99, name: "مدير", customerId: "0000000099", role: "admin" },
];

beforeEach(() => vi.clearAllMocks());

describe("source-qualified request keys", () => {
  it("accepts exact source keys, rejects aliases, malformed keys and unsupported categories", () => {
    expect(parseAdminRequestKey("coin-order-7")).toEqual({ kind: "coin-order", id: 7 });
    expect(parseAdminRequestKey("support-10-external_transaction")).toEqual({ kind: "support", id: 10, category: "external_transaction" });
    expect(parseAdminRequestKey("guest-3")).toEqual({ kind: "guest", id: 3 });
    for (const key of ["payment-0", "payment-01", "payment-1-extra", "payment-1\n", "transfer--1", "coin-1", "support-10-unknown", "payment-2147483648", "REQ-123"]) {
      expect(parseAdminRequestKey(key), key).toBeNull();
      expect(adminRequestDetailsInputSchema.safeParse({ key }).success, key).toBe(false);
    }
    expect(adminRequestDetailsInputSchema.safeParse({ key: "payment-1", reference: "foo" }).success).toBe(false);
  });
  it("enforces the existing administrator guard before any detail read", async () => {
    vi.mocked(requireAdministrator).mockRejectedValueOnce(new Error("forbidden"));
    await expect(getAdminRequestDetails(7, { key: "payment-1" })).rejects.toThrow("forbidden");
    expect(requireAdministrator).toHaveBeenCalledWith(7);
  });
  it("reads exactly the named table and ID, even if references and IDs collide", async () => {
    const fake = fakeDb({ users, requests: [{ id: 1, userId: 10, type: "deposit", reference: "SAME", amount: "120.00", currency: "EGP", status: "approved", createdAt: when, reviewedAt: reviewed, reviewedBy: 99 }], money_transfers: [{ id: 1, senderUserId: 10, recipientUserId: 11, reference: "SAME", amount: "40.00", currency: "EGP", status: "pending", createdAt: when }, { id: 2, senderUserId: 10, reference: "ONLY-TRANSFER", amount: "2", currency: "EGP", status: "pending", createdAt: when }] });
    vi.mocked(requireAdministrator).mockResolvedValue(fake.db as any);
    const payment = await getAdminRequestDetails(99, { key: "payment-1" });
    expect(payment).toMatchObject({ title: "إيداع", reference: "SAME", amount: "120.00", customerName: "عميل حقيقي", status: "approved", review: { section: "requests", tab: "payments", id: 1, key: "payment-1" } });
    expect(payment.history).toContainEqual(expect.objectContaining({ label: "آخر مراجعة مسجلة", actor: "مدير", at: reviewed.toISOString() }));
    const transfer = await getAdminRequestDetails(99, { key: "transfer-1" });
    expect(transfer).toMatchObject({ title: "تحويل أموال", reference: "SAME", amount: "40.00", review: { section: "requests", tab: "transfers", key: "transfer-1" } });
    expect(transfer.fields).toContainEqual({ label: "المستلم", value: "مستلم" });
    await expect(getAdminRequestDetails(99, { key: "payment-2" })).rejects.toThrow("الطلب غير موجود لهذا النوع");
    const sourceCalls = fake.calls.filter((call) => ["requests", "money_transfers"].includes(call.table));
    expect(sourceCalls.map((call) => [call.table, call.params])).toEqual([["requests", [1]], ["money_transfers", [1]], ["requests", [2]]]);
    expect(sourceCalls.every((call) => !call.sql.includes("reference"))).toBe(true);
  });
});

describe("confidentiality and incomplete history", () => {
  it("omits storage paths, credentials, arbitrary dynamic values and full national IDs", async () => {
    const fake = fakeDb({ users, requests: [{ id: 4, userId: 10, type: "deposit", reference: "PAY-4", amount: "12", currency: "EGP", status: "pending", createdAt: when, receiptImageUrl: "/private/SECRET-PATH", payloadHash: "SECRET-HASH", clientOperationId: "SECRET-OPERATION", senderReference: "01012345678", customFields: JSON.stringify({ values: { otp: "987654", holder: "اسم" }, labels: { otp: "كود التحقق", holder: "اسم صاحب الحساب" } }), note: "الرقم القومي 12345678901234" }] });
    vi.mocked(requireAdministrator).mockResolvedValue(fake.db as any);
    const result = await getAdminRequestDetails(99, { key: "payment-4" });
    expect(result.attachments).toEqual([{ label: "إيصال التحويل", access: "payment-receipt" }]);
    const serialized = JSON.stringify(result);
    for (const secret of ["SECRET-PATH", "SECRET-HASH", "SECRET-OPERATION", "987654", "01012345678", "12345678901234"]) expect(serialized).not.toContain(secret);
    expect(result.fields.find((item) => item.label.includes("المرسل"))?.value).toBe("••••5678");
    expect(result.limitations.join(" ")).toContain("لا يتوفر سجل تدقيق كامل");
    const source = fake.calls.find((call) => call.table === "requests")!;
    expect(source.columns).not.toContain("receiptImageUrl");
    expect(source.columns).not.toContain("payloadHash");
    expect(source.columns).not.toContain("clientOperationId");
  });
  it("redacts sensitive labels, long identifiers and arbitrary unknown fields", () => {
    expect(safeRequestText("كلمة المرور hunter2")).toBe("محجوب لحماية البيانات الحساسة");
    expect(safeRequestText("الرقم 12345678901234")).not.toContain("12345678901234");
    expect(safeRequestText("١٢٣٤٥٦٧٨٩٠١٢٣٤")).not.toContain("١٢٣٤٥٦٧٨٩٠١٢٣٤");
    expect(safeRequestText("1234567890123456789012345")).not.toContain("1234567890123456789012345");
    const fields = maskedDynamicFields(JSON.stringify([{ key: "playerId", label: "ID اللاعب", value: "123456" }, { key: "foo", label: "رمز التحقق", value: "SECRET" }, { key: "withdrawalCode", label: "كود السحب", value: "PRIVATE" }]), "game");
    expect(fields[0].value).toBe("123456");
    expect(JSON.stringify(fields)).not.toContain("SECRET");
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    expect(maskedDynamicFields("{not-json", "payment")).toEqual([]);
  });
  it("exposes current verification data only, never ciphertext or complete identity documents", async () => {
    const fake = fakeDb({ users, account_verifications: [{ id: 5, userId: 10, status: "pending", submittedAt: when, nameSnapshot: "عميل حقيقي", nationalIdLast4: "1234", phoneNumberSnapshot: "01012345678", idFrontCiphertext: "CIPHERTEXT", nationalIdFingerprint: "FINGERPRINT", nationalId: "12345678901234" }] });
    vi.mocked(requireAdministrator).mockResolvedValue(fake.db as any);
    const result = await getAdminRequestDetails(99, { key: "account-verification-5" });
    expect(result.reference).toBe("AV-5");
    expect(result.review).toMatchObject({ section: "accountVerification", id: 5, userId: 10 });
    expect(result.attachments[0].access).toBe("specialist");
    for (const secret of ["CIPHERTEXT", "FINGERPRINT", "12345678901234", "01012345678"]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(fake.calls.find((call) => call.table === "account_verifications")!.columns).not.toContain("idFrontCiphertext");
  });
  it("loads exactly one conversation category, leaves replies open, and identifies protected attachments", async () => {
    const fake = fakeDb({ users, support_messages: [
      { id: 1, userId: 10, category: "account", senderRole: "user", body: "أحتاج مساعدة", attachmentMimeType: "image/png", attachmentCiphertext: "DO-NOT-EXPOSE", createdAt: when },
      { id: 2, userId: 10, category: "account", senderRole: "admin", adminId: 99, body: "سنراجع الطلب", createdAt: reviewed },
      { id: 3, userId: 10, category: "freeze", senderRole: "user", body: "OTHER CATEGORY", createdAt: when },
    ], support_thread_states: [{ id: 1, userId: 10, category: "account", status: "open" }] });
    vi.mocked(requireAdministrator).mockResolvedValue(fake.db as any);
    const result = await getAdminRequestDetails(99, { key: "support-10-account" });
    expect(result.status).toBe("open");
    expect(result.review).toMatchObject({ userId: 10, category: "account", section: "supportMessaging" });
    expect(result.history.map((item) => item.detail)).toContain("سنراجع الطلب");
    expect(JSON.stringify(result)).not.toContain("OTHER CATEGORY");
    expect(JSON.stringify(result)).not.toContain("DO-NOT-EXPOSE");
    expect(result.attachments[0].access).toBe("specialist");
    expect(fake.calls.find((call) => call.table === "support_messages")!.params).toEqual([10, "account"]);
  });
  it("uses a guest ticket ID and shows recorded closure events without exposing secrets", async () => {
    const fake = fakeDb({ users, guest_support_tickets: [{ id: 8, ticketCode: "FLX-EXAMPLE", displayName: "زائر", status: "closed", createdAt: when, closedAt: reviewed, otpChallengeId: "NEVER" }], guest_support_messages: [{ id: 1, ticketId: 8, senderRole: "guest", body: "مشكلة في الطلب", attachmentMimeType: "application/pdf", attachmentCiphertext: "PRIVATE-DATA", createdAt: when }], guest_support_audit_events: [{ id: 3, ticketId: 8, action: "status_change", newStatus: "closed", adminId: 99, createdAt: reviewed }] });
    vi.mocked(requireAdministrator).mockResolvedValue(fake.db as any);
    const result = await getAdminRequestDetails(99, { key: "guest-8" });
    expect(result).toMatchObject({ reference: "FLX-EXAMPLE", status: "closed", review: { guestTicketId: 8, section: "guestSupport" } });
    expect(result.history).toContainEqual(expect.objectContaining({ label: "تغيير حالة المحادثة: closed", actor: "مدير" }));
    expect(JSON.stringify(result)).not.toContain("PRIVATE-DATA");
    expect(JSON.stringify(result)).not.toContain("NEVER");
  });
});

describe("remaining source mappings", () => {
  it.each([
    { key: "savings-6", table: "savings_plans", section: "savings", reference: "SAVE-6", amount: "1000", currency: "EGP", values: { reference: "SAVE-6", principalAmount: "1000", currency: "EGP", frequency: "monthly", ratePercent: "1.2", status: "pending_approval" } },
    { key: "game-6", table: "game_topup_requests", section: "gameTopup", reference: "GAME-6", amount: "50", currency: "EGP", values: { reference: "GAME-6", kind: "withdraw", gameName: "لعبة", totalAmount: "50", playerDataJson: "[]", withdrawalCode: "PRIVATE-WITHDRAW", status: "new" } },
    { key: "external-6", table: "external_transfer_requests", section: "externalTransfers", reference: "EXT-6", amount: "12", currency: "EUR", values: { reference: "EXT-6", foreignAmount: "12", currencyCode: "EUR", countryName: "دولة", status: "new" } },
    { key: "gold-6", table: "gold_orders", section: "gold", reference: "GOLD-6", amount: "60", currency: "EGP", values: { reference: "GOLD-6", side: "sell", grossAmount: "60", karat: "21", status: "pending_review" } },
    { key: "coin-order-6", table: "coin_orders", section: "coin", reference: "COIN-ORDER-6", amount: "20", currency: "EGP", values: { reference: "COIN-ORDER-6", side: "buy", totalAmount: "20", quantity: "2", status: "pending" } },
    { key: "coin-transfer-6", table: "coin_transfers", section: "coin", reference: "COIN-TRANSFER-6", amount: "3", currency: "COIN", values: { reference: "COIN-TRANSFER-6", senderUserId: 10, recipientUserId: 11, quantity: "3", status: "pending" } },
    { key: "phone-change-6", table: "phone_change_requests", section: "phoneChange", reference: "PHC-6", amount: null, currency: null, values: { newPhoneNumber: "01012345678", status: "pending", idFrontCiphertext: "PRIVATE-ID" } },
    { key: "phone-verification-6", table: "phone_verification_requests", section: "phoneVerification", reference: "PHV-6", amount: null, currency: null, values: { phoneNumber: "01012345678", status: "pending" } },
  ])("loads $key from its own table only", async (testCase) => {
    const fake = fakeDb({ users, [testCase.table]: [{ id: 6, userId: 10, createdAt: when, ...testCase.values }] });
    vi.mocked(requireAdministrator).mockResolvedValue(fake.db as any);
    const result = await getAdminRequestDetails(99, { key: testCase.key });
    expect(result).toMatchObject({ key: testCase.key, reference: testCase.reference, amount: testCase.amount, currency: testCase.currency, review: { section: testCase.section, id: 6 } });
    expect(fake.calls[0].table).toBe(testCase.table);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-WITHDRAW");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-ID");
    if (testCase.key.startsWith("game-")) expect(result.title).toBe("سحب ألعاب");
  });
});
