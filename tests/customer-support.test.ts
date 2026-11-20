import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../server/routers";
import {
  buildSupportEmailUri,
  buildTelegramUrl,
  customerSupportSettingsSchema,
  normalizeTelegramUsername,
} from "../shared/customer-support";

const customerSupportService = vi.hoisted(() => ({
  getCustomerSupportSettings: vi.fn(),
  updateCustomerSupportSettings: vi.fn(),
  savedSettings: { email: "", telegramUsername: "", links: [] as { id: string; label: string; url: string; icon: "link-outline"; enabled: boolean }[] },
}));

vi.mock("../server/customer-support", () => ({
  getCustomerSupportSettings: customerSupportService.getCustomerSupportSettings,
  updateCustomerSupportSettings: customerSupportService.updateCustomerSupportSettings,
}));

function caller(user: { id: number; role: "user" | "admin"; email: string; profileCompletedAt?: Date | null } | null) {
  return appRouter.createCaller({ req: {} as any, res: { setHeader: vi.fn() } as any, user } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  customerSupportService.savedSettings = { email: "support@example.org", telegramUsername: "FlotexHelp", links: [] };
  customerSupportService.getCustomerSupportSettings.mockImplementation(async () => ({ ...customerSupportService.savedSettings }));
  customerSupportService.updateCustomerSupportSettings.mockImplementation(async (_adminId: number, settings: unknown) => {
    customerSupportService.savedSettings = settings as typeof customerSupportService.savedSettings;
    return { ...customerSupportService.savedSettings };
  });
});

describe("إعدادات خدمة العملاء", () => {
  it("يتحقق من أسماء Telegram ويقبل الاسم أو رابط t.me الصحيح فقط", () => {
    expect(normalizeTelegramUsername(" @Flotex_Help1 ")).toBe("Flotex_Help1");
    expect(normalizeTelegramUsername("https://t.me/Flotex_Help1")).toBe("Flotex_Help1");
    expect(normalizeTelegramUsername("t.me/Flotex_Help1")).toBe("Flotex_Help1");
    expect(normalizeTelegramUsername("four")).toBeNull();
    expect(normalizeTelegramUsername("https://evil.example/Flotex_Help1")).toBeNull();
    expect(normalizeTelegramUsername("https://t.me/Flotex_Help1?start=other")).toBeNull();
    expect(normalizeTelegramUsername("https://t.me/Flotex_Help1/other")).toBeNull();
    expect(buildTelegramUrl("@Flotex_Help1")).toBe("https://t.me/Flotex_Help1");
    expect(buildTelegramUrl("")).toBeNull();
  });

  it("يتحقق من البريد ويقبل ترك قنوات التواصل فارغة دون اختراع عنوان", () => {
    expect(customerSupportSettingsSchema.parse({ email: " Help@Example.org ", telegramUsername: "" })).toEqual({ email: "help@example.org", telegramUsername: "", links: [] });
    expect(customerSupportSettingsSchema.safeParse({ email: "not-an-email", telegramUsername: "FlotexHelp" }).success).toBe(false);
    expect(customerSupportSettingsSchema.safeParse({ email: "help@example.org", telegramUsername: "https://example.org/not-telegram" }).success).toBe(false);
    expect(buildTelegramUrl("")).toBeNull();
  });

  it("يبني رسالة بريد تتضمن رقم العميل ونوع العملية ومرجعها ولا تتضمن أسرار دخول", () => {
    const uri = buildSupportEmailUri("support@example.org", { customerId: "0012345678", operation: "withdrawal", requestId: "REQ_123-ABC" });
    expect(uri).toContain("mailto:support@example.org");
    expect(decodeURIComponent(uri ?? "")).toContain("0012345678");
    expect(decodeURIComponent(uri ?? "")).toContain("نوع العملية: سحب");
    expect(decodeURIComponent(uri ?? "")).toContain("REQ_123-ABC");
    expect(decodeURIComponent(uri ?? "").toLowerCase()).not.toMatch(/password|session|token|كلمة المرور|رمز جلسة/);
    expect(buildSupportEmailUri("", { operation: "general" })).toBeNull();
  });

  it("يتطلب جلسة مصادقًا عليها لقراءة الإعداد ويسمح بالحساب المسجل غير المكتمل أيضًا", async () => {
    const guest = caller(null);
    await expect(guest.customerSupport.settings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const incomplete = caller({ id: 3, role: "user", email: "new@example.org", profileCompletedAt: null });
    await expect(incomplete.customerSupport.settings()).resolves.toEqual({ email: "support@example.org", telegramUsername: "FlotexHelp", links: [] });

    const customer = caller({ id: 4, role: "user", email: "customer@example.org", profileCompletedAt: new Date() });
    await expect(customer.customerSupport.settings()).resolves.toEqual({ email: "support@example.org", telegramUsername: "FlotexHelp", links: [] });
  });

  it("يحفظ المدير الإعدادات بعد تطبيعها ويرفض تعديلها من حساب غير إداري", async () => {
    const admin = caller({ id: 7, role: "admin", email: "dyblhwyty@gmail.com" });
    const links = [{ id: "link_whatsapp", label: "WhatsApp", url: "https://wa.me/201001234567", icon: "logo-whatsapp" as const, enabled: true }];
    const saved = await admin.admin.updateCustomerSupportSettings({ email: " Help@Example.org ", telegramUsername: "https://t.me/FlotexHelp", links });
    expect(saved).toEqual({ email: "help@example.org", telegramUsername: "FlotexHelp", links });
    expect(customerSupportService.updateCustomerSupportSettings).toHaveBeenCalledWith(7, { email: "help@example.org", telegramUsername: "FlotexHelp", links });

    const reopened = caller({ id: 8, role: "user", email: "customer@example.org", profileCompletedAt: new Date() });
    await expect(reopened.customerSupport.settings()).resolves.toEqual(saved);
    expect(customerSupportService.getCustomerSupportSettings).toHaveBeenCalled();

    const customer = caller({ id: 8, role: "user", email: "customer@example.org", profileCompletedAt: new Date() });
    await expect(customer.admin.updateCustomerSupportSettings({ email: "x@example.org", telegramUsername: "FlotexHelp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يقبل روابط HTTPS وmailto وtel الآمنة فقط، مع إبقاء الرابط الاختياري قابلًا للإخفاء", () => {
    const base = { email: "", telegramUsername: "", links: [{ id: "link_whatsapp", label: "واتساب", url: "https://wa.me/201001234567", icon: "logo-whatsapp", enabled: false }] };
    expect(customerSupportSettingsSchema.safeParse(base).success).toBe(true);
    expect(customerSupportSettingsSchema.safeParse({ ...base, links: [{ ...base.links[0], url: "javascript:alert(1)" }] }).success).toBe(false);
    expect(customerSupportSettingsSchema.safeParse({ ...base, links: [{ ...base.links[0], url: "http://example.org" }] }).success).toBe(false);
    expect(customerSupportSettingsSchema.safeParse({ ...base, links: Array.from({ length: 13 }, (_, index) => ({ ...base.links[0], id: `link_${index}_item` })) }).success).toBe(false);
  });
});
