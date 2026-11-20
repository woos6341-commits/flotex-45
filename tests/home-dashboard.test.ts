import { describe, expect, it } from "vitest";
import { getHomeDisplayName, getHomeVerificationNotice, HOME_QUICK_ACTIONS } from "../shared/home-dashboard";

describe("اسم مستخدم الصفحة الرئيسية", () => {
  it("يعرض الاسم الكامل المسجل بعد تطبيع المسافات", () => {
    expect(getHomeDisplayName({ name: "  سارة   محمد إبراهيم  ", givenName: "سارة" })).toBe("سارة محمد إبراهيم");
  });

  it("يستخدم الاسم الأول واسم الأب فقط عند غياب الاسم الكامل", () => {
    expect(getHomeDisplayName({ name: null, givenName: "سارة", fatherName: "محمد إبراهيم" })).toBe("سارة محمد إبراهيم");
  });

  it("يستخدم قيمة احتياطية محايدة إن كانت حقول الاسم فارغة", () => {
    expect(getHomeDisplayName({})).toBe("مستثمر");
  });
});

describe("اختصارات الصفحة الرئيسية", () => {
  it("تحافظ على مسارات الإيداع والتحويل والسحب والإدخار وشحن الألعاب والسجل ووسائل الدفع", () => {
    expect(HOME_QUICK_ACTIONS.map(({ id, route }) => [id, route])).toEqual([
      ["deposit", "/deposit"],
      ["transfer", "/transfer"],
      ["externalTransfers", "/external-transfers"],
      ["withdrawal", "/withdrawal"],
      ["savings", "/savings"],
      ["gameTopup", "/game-topup"],
      ["coin", "/coin-wallet"],
      ["transactions", "/(tabs)/activity"],
      ["paymentMethods", "/(tabs)/wallet"],
    ]);
  });
});

describe("حالة التوثيق في الرئيسية", () => {
  it("يخفي دعوة التوثيق بعد الاعتماد", () => {
    expect(getHomeVerificationNotice("approved")).toBeNull();
  });

  it("يعرض الانتظار دون مسار لإرسال طلب مكرر", () => {
    expect(getHomeVerificationNotice("pending")).toMatchObject({ tone: "muted", action: null });
  });

  it("يعرض سبب الرفض ويتيح إعادة التقديم", () => {
    expect(getHomeVerificationNotice("rejected", "الصورة غير واضحة")).toMatchObject({
      message: "سبب الرفض: الصورة غير واضحة",
      tone: "red",
      action: "reapply",
    });
  });

  it("يتيح التقديم الأول عند عدم وجود طلب", () => {
    expect(getHomeVerificationNotice("not_submitted")).toMatchObject({ tone: "gold", action: "submit" });
  });

  it("لا يعرض اعتمادًا أو دعوة مبكرة قبل وصول الحالة", () => {
    expect(getHomeVerificationNotice(undefined)).toBeNull();
  });
});
