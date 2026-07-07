// Wails runtime はテキストクリップボードしか公開しないため、画像コピーはフロント側
// のブラウザ Clipboard API で完結させる (#127)。デコードは WebView (本番 WebView2 /
// dev WebKitGTK) に任せて Go 側から外す — avif の「WebView へ委譲」(#118) と一貫。

import { ReadImage } from "../../../wailsjs/go/main/App";
import { toBytes } from "./base64";

// png へ正規化するのは、Chromium の ClipboardItem が paste 先へ確実に渡せるのが
// image/png だけのため (PNG は素通し、他は WebView でデコード→canvas 再エンコード)。
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

// ユーザー操作 (コンテキストメニュー等) から呼ぶ必要がある — Clipboard API は
// transient activation を要求するため。IPC + デコード / 再エンコードが write() 前に
// activation window を使い切らないよう、ClipboardItem には解決済み Blob ではなく
// Blob の *promise* を渡す (Chromium は遅延 blob をサポート)。
export async function copyImageToClipboard(absPath: string): Promise<void> {
  // 非同期画像クリップボードが無い環境 (dev = WebKitGTK, §D9) で、promise chain の
  // 奥の raw TypeError ではなく呼び出し側がログできる明確なメッセージで早期に失敗させる。
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
