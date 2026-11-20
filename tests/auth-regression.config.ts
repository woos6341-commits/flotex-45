import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Several historical *.test.ts files create or delete financial records. Never
// allow the test runner to connect to the project's shared development database.
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  let localTestDatabase = false;
  try {
    const target = new URL(databaseUrl);
    localTestDatabase = target.hostname === "127.0.0.1" && /^\/flotex_test_[a-zA-Z0-9_]+$/.test(target.pathname);
  } catch {
    // Invalid or ambiguous targets are not safe test databases.
  }
  if (!localTestDatabase) {
    throw new Error("Refusing to run tests against a non-isolated database. Use a loopback flotex_test_* database or unset DATABASE_URL.");
  }
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
  test: { environment: "node", fileParallelism: false },
});
