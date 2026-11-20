import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { ADMIN_EMAIL } from "../shared/admin";
import { createImmediateAdminAccount, listImmediateAdminAccounts, completeInitialPasswordChange } from "../server/admin-immediate-accounts";
import { loginManualAccount } from "../server/manual-auth";
import { verifyPassword } from "../server/manual-auth-crypto";
import { sdk } from "../server/_core/sdk";

// All signing and provider configuration in this suite is synthetic and local.
vi.mock("../server/_core/env", () => ({ ENV: { appId: "isolated-test", cookieSecret: "synthetic-test-only-signing-value", oAuthServerUrl: "", databaseUrl: "", isProduction: false, forgeApiUrl: "", forgeApiKey: "", marketDataProvider: "not_configured", goldApiKey: "", goldApiBaseUrl: "", savingsCronSecret: "", brokerProvider: "not_configured", paymentProvider: "not_configured", brokerWebhookSecret: "", liveTradingEnabled: false, livePaymentsEnabled: false } }));

const testUrl = process.env.ADMIN_IMMEDIATE_TEST_DATABASE_URL;
const integration = testUrl ? describe : describe.skip;
const temporaryPassword = "temporary password 123";
const newPassword = "client private password 456";
const form = { name: "عميل اختبار", email: "client@example.test", phoneNumber: "01012345678", birthDate: "1990-02-20", governorate: "القاهرة", password: temporaryPassword, confirmPassword: temporaryPassword };
let connection: mysql.Connection;

integration("direct admin accounts, isolated loopback database only", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !/^flotex_test_admin_immediate_[a-zA-Z0-9_]+$/.test(url.pathname.slice(1)) || process.env.DATABASE_URL !== testUrl || process.env.FLOTEX_RUN_LOCAL_DB_TESTS !== "1") throw new Error("Refusing to run outside an explicitly designated local test database.");
    connection = await mysql.createConnection(testUrl!);
    const [tables] = await connection.query<any[]>("SHOW TABLES");
    if (tables.length) throw new Error("Refusing to run on a non-empty database.");
    for (const path of ["./admin-created-accounts-fixture.sql", "../drizzle/admin-created-accounts.sql", "../drizzle/0055_giant_plazm.sql", "../drizzle/0056_hot_starfox.sql"]) {
      const ddl = readFileSync(new URL(path, import.meta.url), "utf8").replace(/--> statement-breakpoint/g, "").split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
      for (const statement of ddl.split(";").map(value => value.trim()).filter(Boolean)) await connection.query(statement);
    }
    await connection.query("CREATE TABLE wallets (id int AUTO_INCREMENT PRIMARY KEY, userId int NOT NULL UNIQUE, balance decimal(14,2) NOT NULL DEFAULT 0.00, reservedWithdrawals decimal(14,2) NOT NULL DEFAULT 0.00, reservedOrders decimal(14,2) NOT NULL DEFAULT 0.00, reservedTransfers decimal(14,2) NOT NULL DEFAULT 0.00, reservedSavings decimal(14,2) NOT NULL DEFAULT 0.00, profitLoss decimal(14,2) NOT NULL DEFAULT 0.00, currency varchar(8) NOT NULL DEFAULT 'EGP', updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB");
    await connection.query("CREATE TABLE auth_device_sessions (id int AUTO_INCREMENT PRIMARY KEY, userId int NOT NULL, tokenHash varchar(64) NOT NULL UNIQUE, deviceId varchar(128) NOT NULL, deviceName varchar(160), platform varchar(32), createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, lastActivityAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, trustedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, revokedAt timestamp NULL, revokeReason varchar(120)) ENGINE=InnoDB");
  });
  beforeEach(async () => {
    for (const table of ["admin_created_account_events", "admin_immediate_accounts", "admin_created_accounts", "auth_device_sessions", "auth_password_credentials", "wallets", "app_settings", "users"]) await connection.query(`DELETE FROM \`${table}\``);
    await connection.execute("INSERT INTO users (id,openId,customerId,name,email,emailNormalized,role,status) VALUES (1,'admin-fixture','1000000001','المسؤول المخول',?,?,'admin','active'), (2,'ordinary-fixture','1000000002','عميل عادي','ordinary@example.test','ordinary@example.test','user','active')", [ADMIN_EMAIL, ADMIN_EMAIL]);
  });
  afterAll(async () => { await connection?.end(); });

  it("creates a real user atomically without marking email verified, with a zero wallet and audit", async () => {
    await expect(createImmediateAdminAccount(2, form)).rejects.toThrow(/المخول/);
    await expect(createImmediateAdminAccount(1, { ...form, email: ADMIN_EMAIL })).rejects.toThrow(/المدير/);
    const created = await createImmediateAdminAccount(1, form);
    const [rows] = await connection.execute<any[]>("SELECT u.*, c.passwordHash, c.emailVerifiedAt, w.balance FROM users u JOIN auth_password_credentials c ON c.userId=u.id JOIN wallets w ON w.userId=u.id WHERE u.customerId=?", [created.customerId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: form.name, emailNormalized: form.email, phoneNormalized: form.phoneNumber, birthDate: form.birthDate, governorate: form.governorate, role: "user", loginMethod: "admin_password_pending", emailVerifiedAt: null });
    expect(Number(rows[0].balance)).toBe(0);
    expect(await verifyPassword(temporaryPassword, rows[0].passwordHash)).toBe(true);
    expect(rows[0].passwordHash).not.toContain(temporaryPassword);
    const [events] = await connection.execute<any[]>("SELECT * FROM admin_created_account_events WHERE requestId=?", [created.id]);
    expect(events.map(event => event.event)).toEqual(["admin_account_created"]);
    expect(JSON.stringify(events)).not.toContain(temporaryPassword);
    expect((await listImmediateAdminAccounts(1))[0]).toMatchObject({ id: created.id, state: "unused", firstLoginAt: null });
    await expect(createImmediateAdminAccount(1, { ...form, email: " CLIENT@EXAMPLE.TEST " })).rejects.toThrow(/البريد/);
    await expect(createImmediateAdminAccount(1, { ...form, email: "other@example.test" })).rejects.toThrow(/الهاتف/);
  });

  it("serializes concurrent creation without duplicate users, wallets, or audit events", async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => createImmediateAdminAccount(1, form)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(3);
    const [users] = await connection.execute<any[]>("SELECT id FROM users WHERE emailNormalized=?", [form.email]);
    const [wallets] = await connection.query<any[]>("SELECT id FROM wallets");
    const [events] = await connection.query<any[]>("SELECT id FROM admin_created_account_events WHERE event='admin_account_created'");
    expect(users).toHaveLength(1); expect(wallets).toHaveLength(1); expect(events).toHaveLength(1);
  });

  it("issues no full session, rejects session bypass, rotates the password once, and records each state", async () => {
    const created = await createImmediateAdminAccount(1, form);
    await expect(loginManualAccount({ email: form.email, password: "wrong" })).rejects.toThrow();
    expect((await listImmediateAdminAccounts(1))[0].state).toBe("unused");
    const first = await loginManualAccount({ email: form.email, password: temporaryPassword });
    if (!("requiresInitialPassword" in first)) throw new Error("Initial-password gate was skipped");
    expect(first.app_session_id).toBeNull();
    expect((await listImmediateAdminAccounts(1))[0]).toMatchObject({ state: "first_login", firstLoginAt: expect.any(Date) });
    const [rows] = await connection.execute<any[]>("SELECT userId,challengeHash FROM admin_immediate_accounts WHERE id=?", [created.id]);
    expect(rows[0].challengeHash).not.toBe(first.challengeToken);
    const [user] = await connection.execute<any[]>("SELECT openId FROM users WHERE id=?", [rows[0].userId]);
    const fabricated = await sdk.createSessionToken(user[0].openId);
    await expect(sdk.authenticateRequest({ headers: { authorization: `Bearer ${fabricated}` } } as any)).rejects.toMatchObject({ statusCode: 403 });
    await expect(completeInitialPasswordChange({ challengeToken: first.challengeToken, password: temporaryPassword, confirmPassword: temporaryPassword })).rejects.toThrow(/مختلفة/);
    await expect(completeInitialPasswordChange({ challengeToken: first.challengeToken, password: newPassword, confirmPassword: "different password" })).rejects.toThrow();
    const second = await loginManualAccount({ email: form.email, password: temporaryPassword });
    if (!("requiresInitialPassword" in second)) throw new Error("Initial-password gate was skipped");
    await expect(completeInitialPasswordChange({ challengeToken: first.challengeToken, password: newPassword, confirmPassword: newPassword })).rejects.toThrow();
    const attempts = await Promise.allSettled([1, 2].map(() => completeInitialPasswordChange({ challengeToken: second.challengeToken, password: newPassword, confirmPassword: newPassword })));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await listImmediateAdminAccounts(1))[0]).toMatchObject({ state: "password_changed", passwordChangedAt: expect.any(Date) });
    await expect(loginManualAccount({ email: form.email, password: temporaryPassword })).rejects.toThrow();
    const signedIn = await loginManualAccount({ email: form.email, password: newPassword, deviceId: "local-test-device" });
    expect(signedIn.app_session_id).toBeTruthy();
    const [credentials] = await connection.execute<any[]>("SELECT emailVerifiedAt,passwordHash FROM auth_password_credentials WHERE userId=?", [rows[0].userId]);
    expect(credentials[0].emailVerifiedAt).toBeNull();
    expect(await verifyPassword(newPassword, credentials[0].passwordHash)).toBe(true);
    const [events] = await connection.execute<any[]>("SELECT event,details FROM admin_created_account_events WHERE requestId=? ORDER BY id", [created.id]);
    expect(events.map(event => event.event)).toEqual(["admin_account_created", "first_login", "password_changed"]);
    expect(JSON.stringify(events)).not.toContain(newPassword);
    expect(JSON.stringify(events)).not.toContain(first.challengeToken);
  });

  it("expires challenges and persists a temporary lock after repeated wrong passwords", async () => {
    const created = await createImmediateAdminAccount(1, form);
    const first = await loginManualAccount({ email: form.email, password: temporaryPassword });
    if (!("requiresInitialPassword" in first)) throw new Error("Initial-password gate was skipped");
    await connection.execute("UPDATE admin_immediate_accounts SET challengeExpiresAt=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=?", [created.id]);
    await expect(completeInitialPasswordChange({ challengeToken: first.challengeToken, password: newPassword, confirmPassword: newPassword })).rejects.toThrow();
    for (let i = 0; i < 5; i++) await expect(loginManualAccount({ email: form.email, password: "wrong password" })).rejects.toThrow();
    await expect(loginManualAccount({ email: form.email, password: temporaryPassword })).rejects.toThrow();
    const [rows] = await connection.execute<any[]>("SELECT failedLoginAttempts,loginLockedUntil FROM admin_immediate_accounts WHERE id=?", [created.id]);
    expect(rows[0].failedLoginAttempts).toBe(5);
    expect(rows[0].loginLockedUntil).toBeTruthy();
    const [lockEvents] = await connection.execute<any[]>("SELECT event FROM admin_created_account_events WHERE requestId=? AND event='initial_login_locked'", [created.id]);
    expect(lockEvents).toHaveLength(1);
    await connection.execute("UPDATE admin_immediate_accounts SET loginLockedUntil=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=?", [created.id]);
    const resumed = await loginManualAccount({ email: form.email, password: temporaryPassword });
    expect("requiresInitialPassword" in resumed).toBe(true);
  });
});
