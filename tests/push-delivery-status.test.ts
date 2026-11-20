import { describe, expect, it } from "vitest";
import { AmbiguousPushDeliveryError, buildExpoPushPayload, classifyPushFailure, isRetryablePushFailure } from "../server/push";
import { buildRequestSubmittedPush } from "../server/push-messages";

describe("push delivery result classification", () => {
  it("marks provider rejection as failed and a network/acceptance ambiguity as unknown", () => {
    expect(classifyPushFailure(new Error("expo_rejected"))).toBe("failed");
    expect(classifyPushFailure(new AmbiguousPushDeliveryError("network_timeout"))).toBe("unknown");
    expect(isRetryablePushFailure(new Error("push_http_429"))).toBe(true);
    expect(isRetryablePushFailure(new AmbiguousPushDeliveryError("push_http_500_result_unknown"))).toBe(false);
    expect(isRetryablePushFailure(new Error("DeviceNotRegistered"))).toBe(false);
  });

  it("routes Android messages through the configured Flotex notification channel", () => {
    const input = { userId: 1, operationId: "operation-123456", title: "عنوان", body: "نص" };
    const android = buildExpoPushPayload("ExpoPushToken[abc123]", input, "android");
    const ios = buildExpoPushPayload("ExpoPushToken[abc123]", input, "ios");
    expect(android.channelId).toBe("flotex-egp");
    expect(ios).not.toHaveProperty("channelId");
  });

  it("announces that a submitted deposit is awaiting review with a distinct idempotency key", () => {
    const message = buildRequestSubmittedPush("deposit", "DEP-123", "250.00", "0.00");
    expect(message.operationId).toBe("request-created:DEP-123");
    expect(message.title).toBe("تم تسجيل طلب الإيداع");
    expect(message.body).toContain("قيد المراجعة");
    expect(message.data).toEqual({ type: "deposit", reference: "DEP-123", event: "submitted" });
  });

  it("reports the reserved withdrawal total and fee without claiming completion", () => {
    const message = buildRequestSubmittedPush("withdrawal", "WDR-456", "100.00", "5.00");
    expect(message.operationId).toBe("request-created:WDR-456");
    expect(message.body).toContain("الرسوم 5.00 ج.م");
    expect(message.body).toContain("إجمالي المبلغ المحجوز 105.00 ج.م");
    expect(message.body).toContain("قيد المراجعة");
  });
});
