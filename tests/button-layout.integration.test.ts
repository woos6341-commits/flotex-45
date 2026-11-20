import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "../server/routers";
import { ADMIN_EMAIL } from "../shared/admin";
import { defaultButtonLayout, moveButton } from "../shared/button-layout";
import { getButtonLayout, getButtonLayoutAudit, writeButtonLayout } from "../server/button-layout";

const isolated = process.env.FLOTEX_RUN_LOCAL_DB_TESTS === "1" && process.env.FLOTEX_ISOLATED_TEST_DB === "1";
const run = isolated ? it : it.skip;
let conn: mysql.Connection;
function admin() { return appRouter.createCaller({ user: { id: 1, role: "admin", email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL }, req: {}, res: { setHeader() {} } } as any); }

beforeAll(async () => {
  if (!isolated) return;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("Missing isolated DB URL");
  const url = new URL(raw);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/flotex_test_button_layout") throw new Error("Refusing non-isolated database");
  conn = await mysql.createConnection(raw);
  // Dedicated synthetic database only; no application migration is executed.
  await conn.query("CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY, role VARCHAR(20), email VARCHAR(320), emailNormalized VARCHAR(320))");
  await conn.query("CREATE TABLE IF NOT EXISTS app_settings (`key` VARCHAR(80) PRIMARY KEY, value TEXT NOT NULL, updatedBy INT, updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)");
  await conn.query("INSERT INTO users (id, role, email, emailNormalized) VALUES (1, 'admin', ?, ?), (2, 'user', 'customer@example.test', 'customer@example.test')", [ADMIN_EMAIL, ADMIN_EMAIL]);
});
afterAll(async () => { if (conn) await conn.end(); });

describe("button layout real database, isolated only", () => {
  run("persists arbitrary coordinates, reads them through tRPC, logs snapshots and restricts writes", async () => {
    const layout = moveButton(defaultButtonLayout("home"), "deposit", 0.73, 1);
    await expect(writeButtonLayout(2, "home", layout)).rejects.toThrow();
    const saved = await admin().admin.buttonLayout.save({ surface: "home", layout });
    expect(saved).toEqual(layout);
    expect(await admin().buttonLayout.get({ surface: "home" })).toEqual(layout);
    expect(await getButtonLayout("home")).toEqual(layout);
    const audit = await getButtonLayoutAudit(1);
    expect(audit[0]).toMatchObject({ actorId: 1, surface: "home", action: "save", before: null, after: layout });
  });
  run("rolls back the position write if audit insertion fails", async () => {
    const original = await getButtonLayout("home");
    const next = moveButton(original!, "transfer", 0.1, 1);
    await conn.query("CREATE TRIGGER reject_layout_audit BEFORE INSERT ON app_settings FOR EACH ROW BEGIN IF NEW.`key` LIKE 'button_layout_audit_v1:%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test audit failure'; END IF; END");
    try { await expect(writeButtonLayout(1, "home", next)).rejects.toThrow(); }
    finally { await conn.query("DROP TRIGGER reject_layout_audit"); }
    expect(await getButtonLayout("home")).toEqual(original);
  });
  run("reset restores legacy default, keeps individual preferences, and logs the reset", async () => {
    await conn.query("INSERT INTO app_settings (`key`, value, updatedBy) VALUES ('home_action_order_v1', '[\"savings\",\"deposit\",\"transfer\",\"withdrawal\"]', 1), ('home_action_order_user_v1:2', '[\"savings\",\"deposit\",\"transfer\",\"withdrawal\"]', 1)");
    await admin().admin.buttonLayout.reset({ surface: "home" });
    expect(await getButtonLayout("home")).toBeNull();
    const [rows] = await conn.query<any[]>("SELECT `key` FROM app_settings WHERE `key` LIKE 'home_action_order%'");
    expect(rows.map((r) => r.key)).toEqual(["home_action_order_user_v1:2"]);
    const audit = await getButtonLayoutAudit(1);
    expect(audit[0]).toMatchObject({ actorId: 1, surface: "home", action: "reset", after: null });
  });
});
