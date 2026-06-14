import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Wails binding before importing clipboard so copyImageToClipboard
// picks up the mock (mirrors logger.test.ts). ReadImage is called internally.
const readImageMock = vi.fn();
vi.mock("../../../wailsjs/go/main/App", () => ({
  ReadImage: (path: string) => readImageMock(path),
}));

// Import after the mock is registered.
const { copyImageToClipboard, toPngBlob } = await import("./clipboard");

describe("toPngBlob", () => {
  it("returns the same Blob untouched when it is already image/png", async () => {
    // Fast-path: no canvas re-encode, so this runs in the default node env
    // without createImageBitmap / canvas support.
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const out = await toPngBlob(png);
    expect(out).toBe(png);
  });
});

describe("copyImageToClipboard", () => {
  let writeMock: ReturnType<typeof vi.fn>;

  // Minimal ClipboardItem stub that just records the data map it was given,
  // so the test can inspect what would land on the clipboard.
  class FakeClipboardItem {
    data: Record<string, Promise<Blob> | Blob>;
    constructor(data: Record<string, Promise<Blob> | Blob>) {
      this.data = data;
    }
  }

  beforeEach(() => {
    readImageMock.mockReset();
    writeMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write: writeMock } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the image and writes an image/png ClipboardItem (png fast-path)", async () => {
    readImageMock.mockResolvedValue({
      data: btoa("fake-png-bytes"),
      mimeType: "image/png",
    });

    await copyImageToClipboard("/abs/foo.png");

    expect(readImageMock).toHaveBeenCalledWith("/abs/foo.png");
    expect(writeMock).toHaveBeenCalledTimes(1);
    const items = writeMock.mock.calls[0][0] as FakeClipboardItem[];
    expect(items).toHaveLength(1);
    // ClipboardItem is handed a Promise<Blob> (so the user gesture isn't
    // consumed); it resolves to a PNG blob via the fast-path.
    const blob = await items[0].data["image/png"];
    expect(blob.type).toBe("image/png");
  });

  it("throws a clear error when the Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {}); // no .clipboard
    readImageMock.mockResolvedValue({
      data: btoa("x"),
      mimeType: "image/png",
    });
    await expect(copyImageToClipboard("/abs/foo.png")).rejects.toThrow(
      /unsupported/i,
    );
    expect(writeMock).not.toHaveBeenCalled();
  });
});
