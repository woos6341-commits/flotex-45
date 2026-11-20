import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ resize: vi.fn(), save: vi.fn(), releaseImage: vi.fn(), releaseContext: vi.fn(), manipulate: vi.fn() }));
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: { manipulate: state.manipulate },
}));
import { base64ImageBytes, compressImageForUpload } from "../lib/image-compression";
const asset = { uri: "file://camera.jpg", width: 4000, height: 3000 } as any;
beforeEach(() => {
  vi.clearAllMocks();
  state.manipulate.mockImplementation(() => ({ resize: state.resize, release: state.releaseContext, renderAsync: async () => ({ saveAsync: state.save, release: state.releaseImage }) }));
  state.save.mockResolvedValue({ uri: "file://small.jpg", width: 1600, height: 1200, base64: Buffer.from("small-data").toString("base64") });
});
describe("bounded image preparation", () => {
  it("counts base64 bytes accurately including padding", () => {
    expect(base64ImageBytes("YQ==")).toBe(1);
    expect(base64ImageBytes("YWI=")).toBe(2);
    expect(base64ImageBytes("YWJj")).toBe(3);
  });
  it("uses aspect-preserving resize and frees native bitmaps after success", async () => {
    const result = await compressImageForUpload(asset);
    expect(result.width).toBe(1600);
    expect(state.resize).toHaveBeenCalledWith({ width: 1600 });
    expect(state.releaseImage).toHaveBeenCalledOnce();
    expect(state.releaseContext).toHaveBeenCalledOnce();
  });
  it("retries using the already reduced file instead of decoding the camera photo again", async () => {
    state.save.mockResolvedValueOnce({ uri: "file://reduced.jpg", width: 1600, height: 1200, base64: Buffer.alloc(1_200_001).toString("base64") });
    await compressImageForUpload(asset);
    expect(state.manipulate.mock.calls.map((call) => call[0])).toEqual([asset.uri, "file://reduced.jpg"]);
    expect(state.releaseImage).toHaveBeenCalledTimes(2);
    expect(state.releaseContext).toHaveBeenCalledTimes(2);
  });
  it("releases native resources when save rejects", async () => {
    state.save.mockRejectedValue(new Error("save-failed"));
    await expect(compressImageForUpload(asset)).rejects.toThrow("save-failed");
    expect(state.releaseImage).toHaveBeenCalledOnce();
    expect(state.releaseContext).toHaveBeenCalledOnce();
  });
  it("rejects invalid dimensions before loading native image resources", async () => {
    await expect(compressImageForUpload({ ...asset, width: 0 })).rejects.toThrow("صورة صالحة");
    expect(state.manipulate).not.toHaveBeenCalled();
  });
});
