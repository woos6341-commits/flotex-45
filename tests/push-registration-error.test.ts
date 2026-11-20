import { describe, expect, it } from "vitest";
import {
  classifyPushRegistrationError,
  getPushRegistrationFailureMessage,
} from "../shared/push-registration-error";

describe("push registration error feedback", () => {
  it("explains native token failures as an Expo/Firebase setup issue", () => {
    const error = classifyPushRegistrationError("token", new Error("native provider failure"));
    const message = getPushRegistrationFailureMessage(error);

    expect(message).toContain("google-services.json");
    expect(message).toContain("FCM V1");
    expect(message).toContain("Development Build");
    expect(message).toContain("Expo Go");
  });

  it("distinguishes an expired login session from a network failure", () => {
    const sessionError = classifyPushRegistrationError("server", { data: { code: "UNAUTHORIZED" } });
    const networkError = classifyPushRegistrationError("server", new Error("Network request failed"));

    expect(getPushRegistrationFailureMessage(sessionError)).toContain("سجّل الخروج ثم الدخول");
    expect(getPushRegistrationFailureMessage(networkError)).toContain("تحقق من الإنترنت");
  });

  it("does not expose raw provider errors or token values to the user", () => {
    const error = classifyPushRegistrationError("server", new Error("failed for ExpoPushToken[private-token]"));
    const message = getPushRegistrationFailureMessage(error);

    expect(message).not.toContain("private-token");
    expect(message).toContain("خادم Flotex");
  });
});
