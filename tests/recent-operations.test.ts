import { describe, expect, it } from "vitest";
import { isPendingRecentOperation } from "../shared/recent-operations";

describe("unified admin operation queue", () => {
  it("keeps only undecided financial requests in review", () => {
    expect(isPendingRecentOperation("requests", "pending")).toBe(true);
    expect(isPendingRecentOperation("requests", "approved")).toBe(false);
    expect(isPendingRecentOperation("requests", "rejected")).toBe(false);
    expect(isPendingRecentOperation("coin", "pending")).toBe(true);
    expect(isPendingRecentOperation("coin", "approved")).toBe(false);
    expect(isPendingRecentOperation("coin", "rejected")).toBe(false);
  });

  it("removes approved, rejected, and active savings plans from review", () => {
    expect(isPendingRecentOperation("savings", "pending_approval")).toBe(true);
    for (const status of ["active", "rejected", "completed", "refunded", "cancelled"]) {
      expect(isPendingRecentOperation("savings", status)).toBe(false);
    }
  });

  it("keeps game requests active until completion, rejection, or cancellation", () => {
    for (const status of ["new", "under_review", "approved", "processing"]) {
      expect(isPendingRecentOperation("gameTopup", status)).toBe(true);
    }
    for (const status of ["completed", "rejected", "cancelled"]) {
      expect(isPendingRecentOperation("gameTopup", status)).toBe(false);
    }
  });

  it("removes external and gold requests after a decision while retaining intermediate review stages", () => {
    for (const status of ["new", "under_review", "awaiting_details"]) {
      expect(isPendingRecentOperation("externalTransfers", status)).toBe(true);
    }
    for (const status of ["approved", "completed", "rejected"]) {
      expect(isPendingRecentOperation("externalTransfers", status)).toBe(false);
    }
    expect(isPendingRecentOperation("gold", "pending_review")).toBe(true);
    for (const status of ["awaiting_execution", "executed", "delivered", "rejected", "cancelled"]) {
      expect(isPendingRecentOperation("gold", status)).toBe(false);
    }
  });

  it("removes account verification, phone change, and phone verification requests after a decision", () => {
    for (const section of ["accountVerification", "phoneChange", "phoneVerification"] as const) {
      expect(isPendingRecentOperation(section, "pending")).toBe(true);
      expect(isPendingRecentOperation(section, "approved")).toBe(false);
      expect(isPendingRecentOperation(section, "rejected")).toBe(false);
      expect(isPendingRecentOperation(section, "cancelled")).toBe(false);
    }
  });
});
