// Wails は Go の []byte を実行時 base64 文字列にするが、生成 TS 型は number[] の
// こともあるため両対応。

export function toDataURL(
  data: number[] | string | Uint8Array,
  mimeType: string
): string {
  let b64: string;
  if (typeof data === "string") {
    b64 = data;
  } else if (Array.isArray(data)) {
    b64 = bytesArrayToBase64(data);
  } else if (data instanceof Uint8Array) {
    b64 = bytesArrayToBase64(Array.from(data));
  } else {
    b64 = String(data);
  }
  return `data:${mimeType};base64,${b64}`;
}

export function bytesArrayToBase64(bytes: number[]): string {
  // 大きい配列で String.fromCharCode(...arr) が call stack を溢れさせないよう分割する。
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

// 全分岐で新しい ArrayBuffer にコピーするのは Uint8Array<ArrayBuffer> 型を保つため
// (TS 6 の BlobPart は SharedArrayBuffer 由来の view を弾く)。
export function toBytes(
  data: number[] | string | Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
