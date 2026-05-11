// Wails serializes Go []byte to JSON as a base64 string at runtime, but the
// generated TS type may say number[]. Handle both forms defensively.

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
  // Chunk to avoid blowing the call stack on String.fromCharCode(...big array).
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

// Decode a Wails []byte payload to a Uint8Array backed by a fresh ArrayBuffer.
// Used when we want the raw bytes (e.g. to build a Blob) rather than a data:
// URL. All branches copy into a new ArrayBuffer so the Uint8Array<ArrayBuffer>
// type holds (BlobPart rejects SharedArrayBuffer-backed views under TS 6).
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
