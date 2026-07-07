import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUPLICATE_THRESHOLD,
  DUPLICATE_DETECT_AUTO,
  DUPLICATE_DETECT_OFF,
  DUPLICATE_DETECT_VALUES,
  MAX_DUPLICATE_THRESHOLD,
  MIN_DUPLICATE_THRESHOLD,
} from "./duplicateDetect";

// AGENTS.md D-1 ドリフト検知: これらのリテラルは Go 側
// `internal/settings.DuplicateDetectAuto` / `DuplicateDetectOff` /
// `defaultDuplicateThreshold` (TestDuplicateDetectValues が pin) と二重管理。
// 片側だけ rename すると、設定 UI が永続化した値を Validate が弾いて
// ユーザーの選択が silent に既定へ戻る (watchMode.test.ts と同じ役割, #136)。
describe("duplicateDetect constants", () => {
  it("DUPLICATE_DETECT_AUTO is the literal 'auto'", () => {
    expect(DUPLICATE_DETECT_AUTO).toBe("auto");
  });

  it("DUPLICATE_DETECT_OFF is the literal 'off'", () => {
    expect(DUPLICATE_DETECT_OFF).toBe("off");
  });

  it("DUPLICATE_DETECT_VALUES enumerates exactly the allowed values", () => {
    expect(DUPLICATE_DETECT_VALUES).toEqual(["auto", "off"]);
  });

  it("threshold default / bounds match the Go side", () => {
    expect(DEFAULT_DUPLICATE_THRESHOLD).toBe(5);
    expect(MIN_DUPLICATE_THRESHOLD).toBe(0);
    expect(MAX_DUPLICATE_THRESHOLD).toBe(16);
  });
});
