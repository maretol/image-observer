// Clipboard image copy (#127). The Wails runtime only exposes text clipboard
// helpers, so image copy is done entirely on the frontend via the browser
// Clipboard API. The WebView (production = WebView2 / dev = WebKitGTK) provides
// the actual clipboard + image decoders, which keeps decoding off the Go side —
// consistent with the avif "delegate decode to the WebView" decision (#118).

import { ReadImage } from "../../../wailsjs/go/main/App";
import { toBytes } from "./base64";

// Convert an image Blob to an `image/png` Blob for the clipboard.
// - PNG passes through untouched (fast-path).
// - Every other format (jpg/gif/webp/avif) is decoded by the WebView via
//   createImageBitmap — the same engine that renders them in <img> (#118) — and
//   re-encoded to PNG through a canvas.
// `image/png` is the only type Chromium's ClipboardItem reliably hands to paste
// targets, so we always normalize to it.
export async function toPngBlob(src: Blob): Promise<Blob> {
  if (src.type === "image/png") return src;
  const bitmap = await createImageBitmap(src);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error("canvas.toBlob returned null")),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}

// Copy the full-resolution image at `absPath` to the OS clipboard as PNG.
// MUST be called from a user gesture (e.g. a context-menu click): the Clipboard
// API requires transient activation. We hand ClipboardItem the Blob *promise*
// rather than an already-resolved Blob so the ReadImage IPC + decode/re-encode
// don't consume the activation window before write() is reached (Chromium
// supports deferred ClipboardItem blobs).
export async function copyImageToClipboard(absPath: string): Promise<void> {
  // Feature-detect up front so environments without the async image clipboard
  // (e.g. dev = WebKitGTK, §D9) fail with a clear message the caller can log,
  // instead of a raw TypeError / ReferenceError deep in the promise chain.
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error(
      "image clipboard copy is unsupported in this environment (navigator.clipboard / ClipboardItem unavailable)",
    );
  }
  const pngPromise = (async () => {
    const res = await ReadImage(absPath);
    const src = new Blob([toBytes(res.data)], { type: res.mimeType });
    return toPngBlob(src);
  })();
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngPromise }),
  ]);
}
