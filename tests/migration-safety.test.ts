import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { destructiveTargets } from "../scripts/migrate-safe";
describe("data-preserving migration preflight", () => {
  it("detects the inherited unbounded wallet zero reset", () => {
    const old = readFileSync(new URL("../drizzle/0005_soft_gambit.sql", import.meta.url), "utf8");
    expect(destructiveTargets(old)).toContain("wallets");
  });
  it("allows additive coin enum and pending-phone backfill with a WHERE clause", () => {
    for (const file of ["0040_pink_micromacro.sql", "0041_pale_scrambler.sql", "0042_phone_pending_backfill.sql"]) {
      expect(destructiveTargets(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"))).toEqual([]);
    }
  });
  it("blocks full deletion/truncation and table drops without confusing index drops", () => {
    expect(destructiveTargets("DELETE FROM `wallets`; TRUNCATE TABLE coin_wallets; DROP TABLE users; ALTER TABLE users DROP INDEX user_index;")).toEqual(["wallets", "coin_wallets", "users"]);
  });
  it("flags dropped columns and trivially unconditional writes", () => {
    expect(destructiveTargets("ALTER TABLE `users` DROP COLUMN `email`; DELETE FROM wallets WHERE 1=1; UPDATE transactions SET amount=0 WHERE TRUE;")).toEqual(["users", "wallets", "transactions"]);
    expect(destructiveTargets("ALTER TABLE users DROP INDEX user_index;")).toEqual([]);
  });
  it("does not treat comments as executable balance resets", () => {
    expect(destructiveTargets("-- UPDATE wallets SET balance = 0;\nALTER TABLE wallets ADD COLUMN example int;")).toEqual([]);
  });
  it("keeps the default migration path guarded", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["db:push"]).toContain("pnpm db:migrate");
    expect(pkg.scripts["db:migrate"]).toBe("tsx scripts/migrate-safe.ts");
    expect(pkg.scripts.start).not.toContain("db:migrate");
    expect(pkg.scripts.start).toContain("check-schema-ready");
  });
});
