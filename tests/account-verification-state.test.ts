import { describe, expect, it, vi } from "vitest";

vi.mock("../server/payment-settings", () => ({ requireAdministrator: vi.fn() }));

import { resolveEffectiveVerificationState } from "../server/account-verification-state";

describe("حالة توثيق الحساب الفعالة", () => {
  const submittedAt = new Date("2026-01-01T10:00:00.000Z");
  const reviewedAt = new Date("2026-01-02T10:00:00.000Z");
  const overrideAt = new Date("2026-01-03T10:00:00.000Z");

  it("يعرض الاعتماد اليدوي الفعلي فوق طلب قديم مرفوض", () => {
    const result = resolveEffectiveVerificationState(
      { status: "manual_verified", reason: "اعتماد المدير", updatedAt: overrideAt, adminId: 8 },
      { status: "rejected", rejectionReason: "مستند غير واضح", submittedAt, reviewedAt, reviewedBy: 4 },
    );
    expect(result).toMatchObject({
      status: "approved",
      rejectionReason: null,
      submittedAt,
      reviewedAt: overrideAt,
      reviewedBy: 8,
      source: "manual",
    });
  });

  it("يلغي الحالة السابقة عند سحب المدير للاعتماد ويعيد فتح التقديم", () => {
    const result = resolveEffectiveVerificationState(
      { status: "revoked", reason: "تحديث بيانات الهوية", updatedAt: overrideAt, adminId: 9 },
      { status: "approved", submittedAt, reviewedAt, reviewedBy: 4 },
    );
    expect(result).toMatchObject({
      status: "not_submitted",
      rejectionReason: null,
      reviewedAt: overrideAt,
      reviewedBy: 9,
      source: "revoked",
    });
  });

  it("يعرض حالة الطلب وسبب الرفض عندما لا يوجد تجاوز إداري", () => {
    const result = resolveEffectiveVerificationState(
      null,
      { status: "rejected", rejectionReason: "صورة الهوية غير واضحة", submittedAt, reviewedAt, reviewedBy: 4 },
    );
    expect(result).toMatchObject({
      status: "rejected",
      rejectionReason: "صورة الهوية غير واضحة",
      submittedAt,
      reviewedAt,
      reviewedBy: 4,
      source: "request",
    });
  });
});
