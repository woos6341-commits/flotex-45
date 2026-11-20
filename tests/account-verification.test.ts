import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountVerifications, appSettings, userProfileAudits, users } from "../drizzle/schema";
import { normalizePhoneNumber } from "../shared/registration";
import { formatLocalDateOnly } from "../shared/date-only";
import { encryptNationalId } from "../server/profile-data";
import { getAdminAccountVerificationDocuments, getMyAccountVerificationStatus, listAdminAccountVerificationRequests, reviewAccountVerification, submitAccountVerification, updateAccountVerificationProfile, updateAdminAccountVerificationSettings } from "../server/account-verification";

const state = vi.hoisted(() => {
  process.env.MANUS_JWT_SECRET = "synthetic-manus-test-secret-0123456789";
  process.env.APP_VERIFICATION_SECRET = "synthetic-account-verification-test-key-0123456789";
  process.env.KYC_DOCUMENT_ENCRYPTION_KEY = "synthetic-kyc-encryption-test-key-0123456789";
  return { database: null as any, user: null as any, request: null as any, duplicateInsert: false, requirement: false, audits: [] as any[] };
});

vi.mock("../server/db", () => ({ getDb: async () => state.database }));
vi.mock("../server/payment-settings", () => ({ requireAdministrator: async () => state.database }));

function validNationalId() {
  const base = "2900101010000";
  const weights = [2, 7, 6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(base[index]) * weight, 0);
  return `${base}${(11 - (sum % 11)) % 10}`;
}

function createDatabaseMock() {
  const tx = {
    select: () => {
      let table: unknown;
      const builder: any = {
        from(value: unknown) { table = value; return builder; },
        where() { return builder; },
        for() { return builder; },
        async limit() {
          if (table === users) return state.user ? [state.user] : [];
          if (table === accountVerifications) return state.request ? [state.request] : [];
          return [];
        },
      };
      return builder;
    },
    insert: (table: unknown) => ({ values: async (values: any) => {
      if (table === accountVerifications) {
        if (state.duplicateInsert) throw { code: "ER_DUP_ENTRY" };
        state.request = { ...values, id: 1 };
      }
      if (table === userProfileAudits) state.audits.push(values);
    } }),
    update: (table: unknown) => ({ set: (values: any) => ({ where: async () => {
      if (table === accountVerifications && state.request) Object.assign(state.request, values);
      if (table === users && state.user) Object.assign(state.user, values);
      return [{ affectedRows: 1 }];
    } }) }),
  };
  const rootSelect = () => {
    let table: unknown;
    const builder: any = {
      from(value: unknown) { table = value; return builder; },
      innerJoin() { return builder; },
      where() { return builder; },
      orderBy() { return builder; },
      async limit() {
        if (table === appSettings) return [{ value: state.requirement ? "true" : "false" }];
        if (table === accountVerifications) return state.request ? [{ ...state.request, customerId: state.user.customerId }] : [];
        return [];
      },
    };
    return builder;
  };
  return {
    transaction: async (callback: (transaction: any) => unknown) => callback(tx),
    select: rootSelect,
    insert: (table: unknown) => {
      const builder: any = {
        values: (values: any) => {
        if (table === appSettings) state.requirement = values.value === "true";
          return builder;
        },
        onDuplicateKeyUpdate: async () => undefined,
      };
      return builder;
    },
  };
}

const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]).toString("base64");
const submission = {
  birthDate: "1990-01-01",
  idFront: { mimeType: "image/jpeg" as const, data: fakeJpeg },
  idBack: { mimeType: "image/jpeg" as const, data: fakeJpeg },
  selfie: { mimeType: "image/jpeg" as const, data: fakeJpeg },
  walletProfile: { mimeType: "image/jpeg" as const, data: fakeJpeg },
};

function tomorrowDateOnly() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatLocalDateOnly(tomorrow);
}

describe("account verification workflow with isolated mocks", () => {
  beforeEach(() => {
    state.request = null;
    state.duplicateInsert = false;
    state.requirement = false;
    state.audits = [];
    const nationalId = validNationalId();
    const phone = "01012345678";
    state.user = {
      id: 17,
      role: "user",
      customerId: "1234567890",
      name: "عميل اختبار",
      givenName: "عميل",
      fatherName: "اختبار",
      email: "synthetic@example.test",
      profileCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
      birthDate: "1990-01-01",
      phoneNumber: phone,
      phoneNormalized: normalizePhoneNumber(phone),
      phoneVerifiedAt: null,
      nationalIdCiphertext: encryptNationalId(nationalId),
    };
    state.database = createDatabaseMock();
  });

  it("stores exactly one pending request with encrypted images and never auto-approves", async () => {
    const result = await submitAccountVerification(17, submission);
    expect(result.status).toBe("pending");
    expect(state.request.status).toBe("pending");
    expect(state.request.idFrontCiphertext).not.toBe(fakeJpeg);
    expect(state.request.nationalIdFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects future birth dates from both customer submissions and administrator corrections", async () => {
    const futureDate = tomorrowDateOnly();
    await expect(submitAccountVerification(17, { ...submission, birthDate: futureDate })).rejects.toThrow("لا يتجاوز اليوم");
    expect(state.request).toBeNull();

    await submitAccountVerification(17, submission);
    await expect(updateAccountVerificationProfile(1, 17, { name: "أحمد اختبار عميل", birthDate: futureDate, phoneNumber: "01012345679" })).rejects.toThrow("لا يتجاوز اليوم");
    expect(state.user.birthDate).toBe("1990-01-01");
  });

  it("keeps a submitted birth date for manual review instead of auto-rejecting a mismatch", async () => {
    const result = await submitAccountVerification(17, { ...submission, birthDate: "1991-01-01" });
    expect(result.status).toBe("pending");
    expect(state.request.birthDateSnapshot).toBe("1991-01-01");
  });

  it("allows one resubmission in the same account after rejection, but blocks a pending duplicate", async () => {
    await submitAccountVerification(17, submission);
    await expect(submitAccountVerification(17, submission)).rejects.toThrow("قيد المراجعة");
    state.request.status = "rejected";
    const result = await submitAccountVerification(17, submission);
    expect(result.status).toBe("pending");
    expect(state.request.status).toBe("pending");
  });

  it("rejects identity or document fingerprints already used by another account", async () => {
    state.duplicateInsert = true;
    await expect(submitAccountVerification(17, submission)).rejects.toThrow("مستخدمة في حساب آخر");
  });

  it("requires manual review before approval and returns documents only through the admin path", async () => {
    await submitAccountVerification(17, submission);
    const pending = await getMyAccountVerificationStatus(17);
    expect(pending.status).toBe("pending");
    expect(pending.requiredBeforeMoney).toBe(false);
    const documents = await getAdminAccountVerificationDocuments(1, 17);
    expect(documents.documents.idFront).toMatch(/^data:image\/jpeg;base64,/);
    expect(documents.documents.walletProfile).toMatch(/^data:image\/jpeg;base64,/);
    const approved = await reviewAccountVerification(1, 17, "approve");
    expect(approved).toMatchObject({ status: "approved", verificationMethod: "manual" });
    expect(state.request.status).toBe("approved");
    expect(state.user.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it("requires a clear rejection reason and never marks a rejected request as verified", async () => {
    await submitAccountVerification(17, submission);
    await expect(reviewAccountVerification(1, 17, "reject", "  ")).rejects.toThrow("سببًا واضحًا");
    const rejected = await reviewAccountVerification(1, 17, "reject", "صورة الهوية غير واضحة");
    expect(rejected).toMatchObject({ status: "rejected", verificationMethod: null });
    expect(state.request).toMatchObject({ status: "rejected", rejectionReason: "صورة الهوية غير واضحة" });
    expect(state.user.phoneVerifiedAt).toBeNull();
  });

  it("shows the full request to the manager, allows pending profile corrections, and freezes edits after review", async () => {
    await submitAccountVerification(17, submission);
    const listed = await listAdminAccountVerificationRequests(1, "pending");
    expect(listed[0]).toMatchObject({ userId: 17, nameSnapshot: "عميل اختبار", birthDateSnapshot: "1990-01-01" });
    const updated = await updateAccountVerificationProfile(1, 17, { name: "أحمد اختبار عميل", birthDate: "1989-02-03", phoneNumber: "01012345679" });
    expect(updated).toMatchObject({ name: "أحمد اختبار عميل", birthDate: "1989-02-03", phoneNumber: "01012345679" });
    expect(state.user).toMatchObject({ name: "أحمد اختبار عميل", birthDate: "1989-02-03", phoneNumber: "01012345679" });
    expect(state.request).toMatchObject({ nameSnapshot: "أحمد اختبار عميل", birthDateSnapshot: "1989-02-03", phoneNumberSnapshot: "01012345679" });
    expect(state.audits).toHaveLength(1);
    await reviewAccountVerification(1, 17, "approve");
    await expect(updateAccountVerificationProfile(1, 17, { name: "اسم جديد", birthDate: "1990-01-01", phoneNumber: "01012345678" })).rejects.toThrow("أثناء مراجعة طلب معلق فقط");
  });

  it("applies the manually reviewed birth date to the customer profile only after approval", async () => {
    await submitAccountVerification(17, { ...submission, birthDate: "1991-02-03" });
    expect(state.user.birthDate).toBe("1990-01-01");
    await reviewAccountVerification(1, 17, "approve");
    expect(state.user.birthDate).toBe("1991-02-03");
    expect(state.user.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(state.audits).toHaveLength(2);
    expect(state.audits.some((audit) => JSON.parse(audit.changes).event === "account_verification_review")).toBe(true);
  });

  it("persists the administrator's enable/disable setting for the actual money-gate status", async () => {
    await updateAdminAccountVerificationSettings(1, true);
    expect((await getMyAccountVerificationStatus(17)).requiredBeforeMoney).toBe(true);
    await updateAdminAccountVerificationSettings(1, false);
    expect((await getMyAccountVerificationStatus(17)).requiredBeforeMoney).toBe(false);
  });
});
