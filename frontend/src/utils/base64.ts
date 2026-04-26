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
