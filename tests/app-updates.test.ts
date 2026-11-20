import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "../server/routers";
import {
  ANDROID_APK_MIME_TYPE,
  compareReleaseVersions,
  decideAndroidUpdate,
  decideAndroidUpdateGate,
  hasNewerRelease,
  isAndroidApkFileName,
  isAndroidApkMimeType,
  isReleaseVersion,
  isSafeAndroidUpdateStorageKey,
  isSafeHttpsDownloadUrl,
  isValidAndroidApkSize,
  MAX_ANDROID_APK_SIZE_BYTES,
  toPublicAndroidUpdatePolicy,
  type AndroidUpdatePolicy,
} from "../shared/app-updates";
import { normalizeAndroidUpdatePolicy } from "../server/app-updates";

const updateService = vi.hoisted(() => ({
  createAndroidUpdateUploadUrl: vi.fn(),
  getAndroidUpdateDownloadUrl: vi.fn(),
  getAndroidUpdatePolicy: vi.fn(),
  getPublicAndroidUpdatePolicy: vi.fn(),
  updateAndroidUpdatePolicy: vi.fn(),
}));

vi.mock("../server/app-updates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/app-updates")>();
  return { ...actual, ...updateService };
});

const DISABLED: AndroidUpdatePolicy = {
  enabled: false,
  version: "",
  buildNumber: 0,
  downloadUrl: "",
  storageKey: "",
  releaseNotes: "",
  mandatory: false,
};
const STORAGE_KEY = "flotex-egp/android-updates/1.0.1/123e4567-e89b-12d3-a456-426614174000.apk";

function caller(user: { id: number; role: "user" | "admin"; email: string; profileCompletedAt?: Date | null } | null) {
  return appRouter.createCaller({ req: {} as any, res: { setHeader: vi.fn() } as any, user } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  updateService.createAndroidUpdateUploadUrl.mockResolvedValue({
    key: STORAGE_KEY,
    uploadUrl: "https://uploads.example.org/signed-put-token",
    contentType: ANDROID_APK_MIME_TYPE,
  });
  updateService.getAndroidUpdateDownloadUrl.mockResolvedValue({
    version: "1.0.1",
    url: "https://downloads.example.org/signed-get-token",
  });
  updateService.getAndroidUpdatePolicy.mockResolvedValue({ ...DISABLED });
  updateService.getPublicAndroidUpdatePolicy.mockResolvedValue({ ...DISABLED });
  updateService.updateAndroidUpdatePolicy.mockImplementation(async (_adminId: number, input: AndroidUpdatePolicy) => normalizeAndroidUpdatePolicy(input));
});

describe("سياسة تحديث Flotex EGP", () => {
  it("يتحقق من صيغة الإصدار ويقارن الأجزاء الرقمية ترتيبًا", () => {
    expect(isReleaseVersion("1.0.1")).toBe(true);
    expect(isReleaseVersion("1.0")).toBe(false);
    expect(isReleaseVersion("1.0.1-beta")).toBe(false);
    expect(compareReleaseVersions("1.9.9", "1.10.0")).toBe(-1);
    expect(compareReleaseVersions("2.0.0", "1.99.99")).toBe(1);
    expect(hasNewerRelease("1.0.0", "1.0.1")).toBe(true);
    expect(hasNewerRelease("1.1.0", "1.0.9")).toBe(false);
  });

  it("لا يقبل إلا رابط HTTPS عام ثابتًا، ويرفض عناوين IP وIPv6 والنطاقات المحلية والرموز المؤقتة", () => {
    expect(isSafeHttpsDownloadUrl("https://downloads.example.org/flotex-egp.apk")).toBe(true);
    for (const url of [
      "http://downloads.example.org/app.apk",
      "https://user:pass@downloads.example.org/app.apk",
      "https://localhost/app.apk",
      "https://foo.localhost/app.apk",
      "https://downloads.example.org/app.apk?token=private",
      "https://127.0.0.1/app.apk",
      "https://192.168.1.10/app.apk",
      "https://0.0.0.0/app.apk",
      "https://[::1]/app.apk",
      "https://[fc00::1]/app.apk",
      "https://host.local/app.apk",
    ]) expect(isSafeHttpsDownloadUrl(url), url).toBe(false);
  });

  it("يتحقق من امتداد APK ونوع MIME والحجم ومفتاح التخزين المطابق للإصدار", () => {
    expect(isAndroidApkFileName("Flotex-1.0.1.APK")).toBe(true);
    expect(isAndroidApkFileName("../evil.apk")).toBe(false);
    expect(isAndroidApkFileName("setup.exe")).toBe(false);
    expect(isAndroidApkMimeType(ANDROID_APK_MIME_TYPE)).toBe(true);
    expect(isAndroidApkMimeType("application/octet-stream")).toBe(true);
    expect(isAndroidApkMimeType("image/png")).toBe(false);
    expect(isValidAndroidApkSize(1)).toBe(true);
    expect(isValidAndroidApkSize(MAX_ANDROID_APK_SIZE_BYTES)).toBe(true);
    expect(isValidAndroidApkSize(MAX_ANDROID_APK_SIZE_BYTES + 1)).toBe(false);
    expect(isValidAndroidApkSize(0)).toBe(false);
    expect(isSafeAndroidUpdateStorageKey(STORAGE_KEY, "1.0.1")).toBe(true);
    expect(isSafeAndroidUpdateStorageKey("flotex-egp/android-updates/1.0.1/101-123e4567-e89b-12d3-a456-426614174000.apk", "1.0.1")).toBe(true);
    expect(isSafeAndroidUpdateStorageKey("flotex-egp/android-updates/1.0.1/100-123e4567-e89b-12d3-a456-426614174000.apk", "1.0.2")).toBe(false);
    expect(isSafeAndroidUpdateStorageKey(STORAGE_KEY, "1.0.2")).toBe(false);
    expect(isSafeAndroidUpdateStorageKey("../android-updates/1.0.1/file.apk", "1.0.1")).toBe(false);
  });

  it("يطبع المدخلات ويدعم قراءة رابط HTTPS قديمًا مع منع تفعيل سياسة بلا ملف أو رابط صالح", () => {
    const legacyPolicy: AndroidUpdatePolicy = {
      enabled: true,
      version: " 1.0.1 ",
      buildNumber: 101,
      downloadUrl: " https://downloads.example.org/flotex-egp-1.0.1.apk ",
      storageKey: "",
      releaseNotes: " إصلاحات وتحسينات. ",
      mandatory: true,
    };
    expect(normalizeAndroidUpdatePolicy(legacyPolicy)).toEqual({
      ...legacyPolicy,
      version: "1.0.1",
      buildNumber: 101,
      downloadUrl: "https://downloads.example.org/flotex-egp-1.0.1.apk",
      releaseNotes: "إصلاحات وتحسينات.",
    });
    expect(normalizeAndroidUpdatePolicy({ ...legacyPolicy, mandatory: false }).mandatory).toBe(true);
    expect(() => normalizeAndroidUpdatePolicy({ ...legacyPolicy, version: "1.0" })).toThrow("رقم الإصدار");
    expect(() => normalizeAndroidUpdatePolicy({ ...legacyPolicy, downloadUrl: "http://downloads.example.org/app.apk" })).toThrow("APK صالحًا");
    expect(normalizeAndroidUpdatePolicy({ ...DISABLED, mandatory: true })).toEqual(DISABLED);

    const directPolicy = normalizeAndroidUpdatePolicy({
      enabled: true,
      version: "1.0.1",
      buildNumber: 101,
      downloadUrl: "",
      storageKey: STORAGE_KEY,
      releaseNotes: "تحديث مباشر",
      mandatory: false,
    });
    expect(directPolicy.storageKey).toBe(STORAGE_KEY);
    expect(directPolicy.downloadUrl).toBe("");
  });

  it("يحسب عرض الإجباري والاختياري ويوقف الطلب عند تثبيت الإصدار المستهدف", () => {
    const policy: AndroidUpdatePolicy = { enabled: true, version: "1.0.1", buildNumber: 101, downloadUrl: "", storageKey: STORAGE_KEY, releaseNotes: "تحسينات", mandatory: true };
    expect(decideAndroidUpdate("1.0.0", policy)).toEqual({ available: true, mandatory: true });
    expect(decideAndroidUpdate("1.0.0", { ...policy, mandatory: false })).toEqual({ available: true, mandatory: false });
    expect(decideAndroidUpdate("1.0.1", policy)).toEqual({ available: false, mandatory: false });
    const gate = { platform: "android", applicationIdMatches: true, policyReady: true, installedVersion: "1.0.0", installedBuildNumber: 100, policy, deferredVersion: null };
    expect(decideAndroidUpdateGate(gate)).toEqual({ available: true, visible: true, mandatory: true });
    expect(decideAndroidUpdateGate({ ...gate, platform: "web" })).toEqual({ available: false, visible: false, mandatory: false });
    expect(decideAndroidUpdateGate({ ...gate, applicationIdMatches: false })).toEqual({ available: false, visible: false, mandatory: false });
    expect(decideAndroidUpdateGate({ ...gate, policyReady: false })).toEqual({ available: false, visible: false, mandatory: false });
    expect(decideAndroidUpdateGate({ ...gate, installedVersion: "1.0.1" })).toEqual({ available: true, visible: true, mandatory: true });
    expect(decideAndroidUpdateGate({ ...gate, policy: { ...policy, mandatory: false }, deferredVersion: "1.0.1" })).toEqual({ available: true, visible: false, mandatory: false });
    expect(decideAndroidUpdateGate({ ...gate, deferredVersion: "1.0.1" })).toEqual({ available: true, visible: true, mandatory: true });
    expect(decideAndroidUpdateGate({ ...gate, installedVersion: "1.0.1", installedBuildNumber: 100 })).toEqual({ available: true, visible: true, mandatory: true });
    expect(decideAndroidUpdateGate({ ...gate, installedVersion: "1.0.1", installedBuildNumber: 101 })).toEqual({ available: false, visible: false, mandatory: false });
  });

  it("لا يكشف مفتاح التخزين الداخلي ضمن سياسة التحديث العامة", () => {
    const publicPolicy = toPublicAndroidUpdatePolicy({
      enabled: true,
      version: "1.0.1",
      buildNumber: 101,
      downloadUrl: "",
      storageKey: STORAGE_KEY,
      releaseNotes: "ملاحظات",
      mandatory: false,
    });
    expect(publicPolicy.storageKey).toBe("");
    expect(publicPolicy.downloadUrl).toBe("");
    expect(publicPolicy.version).toBe("1.0.1");
    const legacyPublicPolicy = toPublicAndroidUpdatePolicy({
      enabled: true,
      version: "1.0.1",
      buildNumber: 101,
      downloadUrl: "https://downloads.example.org/flotex-egp.apk",
      storageKey: "",
      releaseNotes: "ملاحظات",
      mandatory: false,
    });
    expect(legacyPublicPolicy.downloadUrl).toBe("");
  });

  it("يحمي رفع APK وحفظ السياسة ويصدر URL التنزيل عند الطلب فقط دون قاعدة بيانات", async () => {
    const admin = caller({ id: 42, role: "admin", email: "dyblhwyty@gmail.com" });
    const policy: AndroidUpdatePolicy = {
      enabled: true,
      version: "1.0.1",
      buildNumber: 101,
      downloadUrl: "",
      storageKey: STORAGE_KEY,
      releaseNotes: "إصلاحات وتحسينات.",
      mandatory: true,
    };
    const publicPolicy = toPublicAndroidUpdatePolicy(policy);
    updateService.getAndroidUpdatePolicy.mockResolvedValue(policy);
    updateService.getPublicAndroidUpdatePolicy.mockResolvedValue(publicPolicy);

    const upload = await admin.admin.androidUpdateUploadUrl({ version: "1.0.1", buildNumber: 101, fileName: "flotex-1.0.1.apk", fileSize: 12345 });
    expect(upload).toEqual({ key: STORAGE_KEY, uploadUrl: "https://uploads.example.org/signed-put-token", contentType: ANDROID_APK_MIME_TYPE });
    expect(updateService.createAndroidUpdateUploadUrl).toHaveBeenCalledWith(42, { version: "1.0.1", buildNumber: 101, fileName: "flotex-1.0.1.apk", fileSize: 12345 });

    const saved = await admin.admin.updateAndroidUpdatePolicy({
      enabled: true,
      version: "1.0.1",
      buildNumber: 101,
      storageKey: STORAGE_KEY,
      releaseNotes: policy.releaseNotes,
      mandatory: true,
    });
    expect(saved).toEqual(policy);
    expect(updateService.updateAndroidUpdatePolicy).toHaveBeenCalledWith(42, { ...policy });
    expect(await admin.admin.androidUpdatePolicy()).toEqual(policy);

    const publicCaller = caller(null);
    expect(await publicCaller.appUpdates.androidPolicy()).toEqual(publicPolicy);
    expect(await publicCaller.appUpdates.androidDownloadUrl({ version: "1.0.1" })).toEqual({ version: "1.0.1", url: "https://downloads.example.org/signed-get-token" });

    const incompleteUser = caller({ id: 14, role: "user", email: "new@example.com", profileCompletedAt: null });
    expect(await incompleteUser.appUpdates.androidDownloadUrl({ version: "1.0.1" })).toEqual({ version: "1.0.1", url: "https://downloads.example.org/signed-get-token" });

    const normalUser = caller({ id: 13, role: "user", email: "user@example.com", profileCompletedAt: new Date() });
    expect(await normalUser.appUpdates.androidDownloadUrl({ version: "1.0.1" })).toEqual({ version: "1.0.1", url: "https://downloads.example.org/signed-get-token" });
    expect(updateService.getAndroidUpdateDownloadUrl).toHaveBeenCalledWith("1.0.1");

    await expect(normalUser.admin.updateAndroidUpdatePolicy({
      enabled: true,
      version: "1.0.1",
      buildNumber: 101,
      storageKey: STORAGE_KEY,
      releaseNotes: policy.releaseNotes,
      mandatory: true,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(normalUser.admin.androidUpdateUploadUrl({ version: "1.0.1", buildNumber: 101, fileName: "flotex.apk", fileSize: 12345 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("لا يكشف رابطًا أو مفتاحًا مخزنًا عندما تكون السياسة معطلة", async () => {
    expect(toPublicAndroidUpdatePolicy({ ...DISABLED, version: "1.0.1", downloadUrl: "https://downloads.example.org/old.apk", storageKey: STORAGE_KEY })).toEqual(DISABLED);
  });
});
