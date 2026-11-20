import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { ADMIN_EMAIL } from "../shared/admin";
import { verifyPassword } from "../server/manual-auth-crypto";
import { createAdminCreatedAccount, listAdminCreatedAccounts, submitAdminCreatedAccount, recordAdminCreatedIdentity, issueAdminCreatedInvitation, claimAdminCreatedInvitation, setAdminCreatedAccountSuspended } from "../server/admin-created-accounts";
import { assertAdminCreatedAccountFinancialAllowed } from "../server/admin-created-accounts-financial-guard";
import { getDb } from "../server/db";

const testUrl = process.env.ADMIN_ACCOUNTS_TEST_DATABASE_URL;
const integration = testUrl ? describe : describe.skip;
const ownerPassword = "strong test password only";
let connection: mysql.Connection;
const base = { name: "عميل تجريبي", email: "customer@example.test" };

integration("admin account creation with isolated local MySQL and fake delivery", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !/^flotex_test_admin_created_[a-zA-Z0-9_]+$/.test(url.pathname.slice(1)) || process.env.DATABASE_URL !== testUrl || process.env.FLOTEX_RUN_LOCAL_DB_TESTS !== "1") {
      throw new Error("Refusing to run: a dedicated loopback flotex_test_admin_created_* database must be explicitly configured.");
    }
    connection = await mysql.createConnection(testUrl!);
    const [tables] = await connection.query<any[]>("SHOW TABLES");
    if (tables.length) throw new Error("Refusing to run on a database that is not empty.");
    const fixture = readFileSync(new URL("./admin-created-accounts-fixture.sql", import.meta.url), "utf8");
    const ddl = readFileSync(new URL("../drizzle/admin-created-accounts.sql", import.meta.url), "utf8");
    const withoutComments = `${fixture}\n${ddl}`.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";").map(x => x.trim()).filter(Boolean)) await connection.query(statement);
  });
  beforeEach(async () => {
    await connection.query("DELETE FROM admin_created_account_events");
    await connection.query("DELETE FROM admin_created_accounts");
    await connection.query("DELETE FROM account_verification_overrides");
    await connection.query("DELETE FROM account_verifications");
    await connection.query("DELETE FROM auth_password_credentials");
    await connection.query("DELETE FROM app_settings");
    await connection.query("DELETE FROM users");
    await connection.execute("INSERT INTO users (id,openId,customerId,name,email,emailNormalized,role,status) VALUES (1,'admin-fixture','1000000001','المسؤول المخول',?,?,'admin','active'), (2,'ordinary-fixture','1000000002','عميل', 'ordinary@example.test','ordinary@example.test','user','active')", [ADMIN_EMAIL, ADMIN_EMAIL]);
  });
  afterAll(async () => { await connection?.end(); });

  it("checks authorization and prevents administrator email and duplicate normalized and legacy email", async () => {
    await expect(createAdminCreatedAccount(2, base)).rejects.toThrow(/المخول/);
    await expect(createAdminCreatedAccount(1, { ...base, email: ` ${ADMIN_EMAIL.toUpperCase()} ` })).rejects.toThrow(/المدير/);
    await connection.query("INSERT INTO users (openId,customerId,email,emailNormalized) VALUES ('legacy','1000000003','  LEGACY@example.test ',NULL)");
    await expect(createAdminCreatedAccount(1, { ...base, email: "legacy@example.test" })).rejects.toThrow(/قائم/);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => createAdminCreatedAccount(1, { ...base, email: " Customer@Example.TEST " })));
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(3);
    const [pending] = await connection.query<any[]>("SELECT * FROM admin_created_accounts");
    expect(pending[0].state).toBe("draft");
    expect(pending[0].createdByName).toBe("المسؤول المخول");
    expect(pending[0].createdAt).toBeTruthy();
    expect(pending[0].userId).toBeNull();
    const [customers] = await connection.query<any[]>("SELECT id FROM users WHERE emailNormalized='customer@example.test'");
    expect(customers).toHaveLength(0);
  });

  it("requires documented identity and mailbox possession, never returns or persists the invitation or password", async () => {
    const draft = await createAdminCreatedAccount(1, base);
    await submitAdminCreatedAccount(1, draft.id);
    let token = "";
    const deliver = async (message: { email: string; token: string }) => { expect(message.email).toBe(base.email); token = message.token; };
    await expect(issueAdminCreatedInvitation(1, draft.id, deliver)).rejects.toThrow(/الهوية/);
    await recordAdminCreatedIdentity(1, { id: draft.id, evidenceRef: "CASE-1234" });
    await expect(issueAdminCreatedInvitation(1, draft.id)).rejects.toThrow(/غير مهيأة/);
    await expect(issueAdminCreatedInvitation(1, draft.id, async () => { throw new Error("fake delivery failure"); })).rejects.toThrow(/تعذر تسليم/);
    const receipt = await issueAdminCreatedInvitation(1, draft.id, deliver);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(receipt)).not.toContain(token);
    const [pending] = await connection.query<any[]>("SELECT * FROM admin_created_accounts WHERE id=?", [draft.id]);
    expect(pending[0].invitationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(pending)).not.toContain(token);
    expect(pending[0].emailVerifiedAt).toBeNull();
    const claimed = await claimAdminCreatedInvitation({ token, password: ownerPassword, confirmPassword: ownerPassword });
    expect(claimed.customerId).toMatch(/^(?!0{10})\d{10}$/);
    await expect(claimAdminCreatedInvitation({ token, password: ownerPassword, confirmPassword: ownerPassword })).rejects.toThrow(/الدعوة/);
    const [created] = await connection.query<any[]>("SELECT * FROM users WHERE emailNormalized=?", [base.email]);
    expect(created).toHaveLength(1);
    expect(created[0].role).toBe("user");
    expect(created[0].profileCompletedAt).toBeNull();
    expect(created[0].status).toBe("active");
    const [creds] = await connection.query<any[]>("SELECT * FROM auth_password_credentials WHERE userId=?", [created[0].id]);
    expect(creds[0].emailVerifiedAt).toBeTruthy();
    expect(creds[0].passwordHash).not.toContain(ownerPassword);
    expect(await verifyPassword(ownerPassword, creds[0].passwordHash)).toBe(true);
    const [audit] = await connection.query<any[]>("SELECT * FROM admin_created_account_events WHERE requestId=?", [draft.id]);
    expect(audit.map(x => x.event)).toEqual(["created", "verification_requested", "identity_reviewed", "invitation_issued", "email_verified_and_activated"]);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(ownerPassword);
    const [views] = await listAdminCreatedAccounts(1);
    expect(views.state).toBe("active");
    expect(views.customerId).toBe(claimed.customerId);
    expect(JSON.stringify(views)).not.toContain(token);
    expect(JSON.stringify(views)).not.toContain(ownerPassword);
  });

  it("revokes replaced and suspended invitations; expiry and racing claims fail closed", async () => {
    const draft = await createAdminCreatedAccount(1, base);
    await submitAdminCreatedAccount(1, draft.id);
    await recordAdminCreatedIdentity(1, { id: draft.id, evidenceRef: "CASE-1234" });
    const delivered: string[] = [];
    const deliver = async ({ token }: { token: string }) => { delivered.push(token); };
    await issueAdminCreatedInvitation(1, draft.id, deliver);
    await issueAdminCreatedInvitation(1, draft.id, deliver);
    await expect(claimAdminCreatedInvitation({ token: delivered[0], password: ownerPassword, confirmPassword: ownerPassword })).rejects.toThrow(/الدعوة/);
    await setAdminCreatedAccountSuspended(1, { id: draft.id, suspended: true, reason: "مراجعة إضافية" });
    await expect(claimAdminCreatedInvitation({ token: delivered[1], password: ownerPassword, confirmPassword: ownerPassword })).rejects.toThrow(/الدعوة/);
    await setAdminCreatedAccountSuspended(1, { id: draft.id, suspended: false, reason: "اكتملت المراجعة" });
    await issueAdminCreatedInvitation(1, draft.id, deliver);
    await connection.execute("UPDATE admin_created_accounts SET invitationExpiresAt=DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id=?", [draft.id]);
    await expect(claimAdminCreatedInvitation({ token: delivered[2], password: ownerPassword, confirmPassword: ownerPassword })).rejects.toThrow(/الدعوة/);
    await issueAdminCreatedInvitation(1, draft.id, deliver);
    const raced = await Promise.allSettled([1, 2].map(() => claimAdminCreatedInvitation({ token: delivered[3], password: ownerPassword, confirmPassword: ownerPassword })));
    expect(raced.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter(x => x.status === "rejected")).toHaveLength(1);
    const [created] = await connection.query<any[]>("SELECT id FROM users WHERE emailNormalized=?", [base.email]);
    expect(created).toHaveLength(1);
  });

  it("refuses to activate if another registration obtained the email while the request was pending", async () => {
    const draft = await createAdminCreatedAccount(1, base);
    await submitAdminCreatedAccount(1, draft.id);
    await recordAdminCreatedIdentity(1, { id: draft.id, evidenceRef: "CASE-1234" });
    let token = "";
    await issueAdminCreatedInvitation(1, draft.id, async data => { token = data.token; });
    await connection.execute("INSERT INTO users (openId,customerId,email,emailNormalized) VALUES ('new-other','1000000004',?,?)", [base.email, base.email]);
    await expect(claimAdminCreatedInvitation({ token, password: ownerPassword, confirmPassword: ownerPassword })).rejects.toThrow(/قائم/);
    const [pending] = await connection.execute<any[]>("SELECT state, emailVerifiedAt, userId FROM admin_created_accounts WHERE id=?", [draft.id]);
    expect(pending[0]).toMatchObject({ state: "verification_required", emailVerifiedAt: null, userId: null });
    const [credentials] = await connection.query<any[]>("SELECT * FROM auth_password_credentials");
    expect(credentials).toHaveLength(0);
  });

  it("fails financial access closed until approved current identity matches, and after changes or revocation", async () => {
    const draft = await createAdminCreatedAccount(1, base);
    await submitAdminCreatedAccount(1, draft.id);
    await recordAdminCreatedIdentity(1, { id: draft.id, evidenceRef: "CASE-1234" });
    let token = "";
    await issueAdminCreatedInvitation(1, draft.id, async message => { token = message.token; });
    await claimAdminCreatedInvitation({ token, password: ownerPassword, confirmPassword: ownerPassword });
    const [rows] = await connection.execute<any[]>("SELECT userId FROM admin_created_accounts WHERE id=?", [draft.id]);
    const id = rows[0].userId as number;
    const db = await getDb();
    if (!db) throw new Error("No isolated database");
    await expect(assertAdminCreatedAccountFinancialAllowed(db, id)).rejects.toThrow(/توثيق الهوية/);
    await connection.execute("UPDATE users SET phoneNumber='01012345678',phoneNormalized='01012345678',birthDate='1990-01-01',nationalIdFingerprint=?,profileCompletedAt=NOW() WHERE id=?", ["a".repeat(64), id]);
    await connection.execute("INSERT INTO account_verifications (userId,status,nameSnapshot,emailSnapshot,phoneNumberSnapshot,birthDateSnapshot,nationalIdFingerprint) VALUES (?,'approved',?,?, '01012345678','1990-01-01',?)", [id, base.name, base.email, "a".repeat(64)]);
    await expect(assertAdminCreatedAccountFinancialAllowed(db, id)).resolves.toBeUndefined();
    await connection.execute("UPDATE users SET name='اسم مختلف' WHERE id=?", [id]);
    await expect(assertAdminCreatedAccountFinancialAllowed(db, id)).rejects.toThrow(/توثيق الهوية/);
    await connection.execute("UPDATE users SET name=? WHERE id=?", [base.name, id]);
    await connection.execute("INSERT INTO account_verification_overrides (userId,status,adminId,updatedAt) VALUES (?,'revoked',1,NOW())", [id]);
    await expect(assertAdminCreatedAccountFinancialAllowed(db, id)).rejects.toThrow(/توثيق الهوية/);
    // Existing customers are not subjected to this opt-in guard.
    await expect(assertAdminCreatedAccountFinancialAllowed(db, 2)).resolves.toBeUndefined();
  });
});
