import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../server/db", () => ({ getDb: dbMock.getDb }));
import { getRecentOperations } from "../server/recent-operations";

describe("recent operations database errors", () => {
  beforeEach(() => dbMock.getDb.mockReset());
  it("rejects when the database is unavailable instead of reporting an empty inbox", async () => {
    dbMock.getDb.mockResolvedValue(undefined);
    await expect(getRecentOperations({ pendingOnly: true })).rejects.toThrow("قاعدة البيانات غير متاحة");
  });
});
