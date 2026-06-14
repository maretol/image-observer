import { describe, expect, it } from "vitest";
import { toPngBlob } from "./clipboard";

describe("toPngBlob", () => {
  it("returns the same Blob untouched when it is already image/png", async () => {
    // Fast-path: no canvas re-encode, so this runs in the default node env
    // without createImageBitmap / canvas support.
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const out = await toPngBlob(png);
    expect(out).toBe(png);
  });
});
