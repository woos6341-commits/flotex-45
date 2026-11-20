import { describe, expect, it } from "vitest";
import { getReadiness } from "../server/providers/readiness";

describe("integration readiness", () => {
  it("keeps market, brokerage and payment integrations disabled when unconfigured", () => {
    const status = getReadiness();
    expect(status.marketData.provider).toBe("not_configured");
    expect(status.marketData.connected).toBe(false);
    expect(status.marketData.simulated).toBe(false);
    expect(status.brokerage.executionEnabled).toBe(false);
    expect(status.payments.liveEnabled).toBe(false);
    expect(status.warning).toContain("لا تُعرض أسعار");
  });
});
