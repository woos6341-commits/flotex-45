import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ os: "android", values: new Map<string, string>(), appStateListeners: new Set<(state: string) => void>(), picker: vi.fn(), pending: vi.fn(), cameraPermission: vi.fn(), libraryPermission: vi.fn(), compress: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { get OS() { return state.os; } }, AppState: { addEventListener: (_event: string, listener: (state: string) => void) => { state.appStateListeners.add(listener); return { remove: () => { state.appStateListeners.delete(listener); } }; } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => state.values.get(key) ?? null,
  setItem: (key: string, value: string) => { state.set(key, value); state.values.set(key, value); return Promise.resolve(); },
  removeItem: (key: string) => { state.remove(key); state.values.delete(key); return Promise.resolve(); },
  getAllKeys: async () => [...state.values.keys()],
  multiRemove: async (keys: string[]) => { keys.forEach((key) => state.values.delete(key)); },
} }));
vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: state.cameraPermission,
  requestMediaLibraryPermissionsAsync: state.libraryPermission,
  launchCameraAsync: state.picker,
  launchImageLibraryAsync: state.picker,
  getPendingResultAsync: state.pending,
  CameraType: { front: "front", back: "back" },
}));
vi.mock("../lib/image-compression", () => ({ compressImageForUpload: state.compress }));
import { clearVerificationPhotoDrafts, getPendingVerificationRoute, pickVerificationPhoto, recoverVerificationPhoto, removeLegacyVerificationDrafts } from "../lib/verification-photo-picker";
const marker = "flotex:pending-verification-camera:v1";
const asset = { uri: "file://raw.jpg", width: 4000, height: 3000 }; // No raw base64 is required.
const photo = { uri: "file://small.jpg", width: 1600, height: 1200, data: "SAFE_COMPRESSED_PAYLOAD", mimeType: "image/jpeg", size: 4096 };
beforeEach(() => {
  vi.clearAllMocks(); state.os = "android"; state.values.clear(); state.appStateListeners.clear();
  state.picker.mockResolvedValue({ canceled: false, assets: [asset] });
  state.pending.mockResolvedValue({ canceled: false, assets: [asset] });
  state.cameraPermission.mockResolvedValue({ granted: true });
  state.libraryPermission.mockResolvedValue({ granted: true });
  state.compress.mockResolvedValue(photo);
});
describe("safe verification photo picking", () => {
  it("accepts a URI-only result, disables raw base64 and stores only a small routing marker", async () => {
    expect(await pickVerificationPhoto("phone", 17, "idFront")).toEqual(photo);
    expect(state.picker).toHaveBeenCalledWith(expect.objectContaining({ base64: false, exif: false, cameraType: "back" }));
    expect(state.compress).toHaveBeenCalledWith(asset);
    expect(JSON.parse(state.set.mock.calls[0][1])).toMatchObject({ userId: 17, scope: "phone", key: "idFront" });
    expect(state.set.mock.calls[0][1]).not.toContain(photo.data);
    expect(state.values.has(marker)).toBe(false);
  });
  it("keeps selfie capture camera-only and wallet profile library-only", async () => {
    await pickVerificationPhoto("account", 17, "selfie");
    expect(state.picker).toHaveBeenCalledWith(expect.objectContaining({ cameraType: "front" }));
    await pickVerificationPhoto("account", 17, "walletProfile");
    expect(state.libraryPermission).toHaveBeenCalledOnce();
  });
  it("cancellation does not compress or clear an existing screen draft", async () => {
    state.picker.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickVerificationPhoto("account", 17, "idFront")).toBeNull();
    expect(state.compress).not.toHaveBeenCalled();
  });
  it("recovers Android's pending camera result when the launch promise returns empty after Activity backgrounding", async () => {
    state.picker.mockImplementationOnce(async () => {
      state.appStateListeners.forEach((listener) => listener("background"));
      return { canceled: true, assets: null };
    });
    state.pending.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    await expect(pickVerificationPhoto("account", 17, "idFront")).resolves.toEqual(photo);
    expect(state.compress).toHaveBeenCalledWith(asset);
    expect(state.values.has(marker)).toBe(false);
  });
  it("retains only the route marker when Android has not exposed its result yet", async () => {
    state.picker.mockImplementationOnce(async () => {
      state.appStateListeners.forEach((listener) => listener("background"));
      return { canceled: true, assets: null };
    });
    state.pending.mockResolvedValue(null);
    await expect(pickVerificationPhoto("account", 17, "idFront")).resolves.toBeNull();
    expect(state.values.has(marker)).toBe(true);
    expect(state.values.get(marker)).not.toContain("SAFE_COMPRESSED_PAYLOAD");
    expect(state.compress).not.toHaveBeenCalled();
  });
  it("reports denied permission and native failures without leaving a pending marker", async () => {
    state.cameraPermission.mockResolvedValue({ granted: false });
    await expect(pickVerificationPhoto("phone", 17, "selfie")).rejects.toThrow("الكاميرا");
    expect(state.picker).not.toHaveBeenCalled();
    state.cameraPermission.mockResolvedValue({ granted: true });
    state.picker.mockRejectedValue(new Error("native-error"));
    await expect(pickVerificationPhoto("phone", 17, "selfie")).rejects.toThrow("native-error");
    expect(state.values.has(marker)).toBe(false);
  });
  it("restores Android's lost result to the exact user's field only", async () => {
    state.values.set(marker, JSON.stringify({ userId: 17, scope: "account", key: "idBack", at: Date.now() }));
    expect(await getPendingVerificationRoute(17)).toBe("/account-verification");
    expect(await getPendingVerificationRoute(18)).toBeNull();
    expect(await recoverVerificationPhoto("phone", 17)).toBeNull();
    expect(state.pending).not.toHaveBeenCalled();
    expect(await recoverVerificationPhoto("account", 17)).toEqual({ key: "idBack", photo });
    expect(state.values.has(marker)).toBe(false);
  });
  it("does not discard the marker when Android exposes the result late", async () => {
    state.values.set(marker, JSON.stringify({ userId: 17, scope: "account", key: "idFront", at: Date.now() }));
    state.pending.mockResolvedValueOnce(null).mockResolvedValueOnce({ canceled: false, assets: [asset] });
    await expect(recoverVerificationPhoto("account", 17)).resolves.toEqual({ key: "idFront", photo });
    expect(state.values.has(marker)).toBe(false);
    state.values.set(marker, JSON.stringify({ userId: 17, scope: "account", key: "idBack", at: Date.now() }));
    state.pending.mockResolvedValue(null);
    await expect(recoverVerificationPhoto("account", 17)).resolves.toBeNull();
    expect(state.values.has(marker)).toBe(true);
  });
  it("deletes obsolete plaintext local drafts without touching unrelated local data", async () => {
    state.values.set("flotex:account-verification-draft:17", "OLD_LARGE_PLAINTEXT");
    state.values.set("preferences", "keep");
    await removeLegacyVerificationDrafts();
    expect(state.values.get("preferences")).toBe("keep");
    expect([...state.values.keys()]).toEqual(["preferences"]);
    await clearVerificationPhotoDrafts();
  });
  it("opens web picker without awaiting native permissions or persistent storage", async () => {
    state.os = "web";
    await pickVerificationPhoto("phone", 17, "walletProfile");
    expect(state.cameraPermission).not.toHaveBeenCalled();
    expect(state.libraryPermission).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });
});
