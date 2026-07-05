// Go 側 internal/settings.DuplicateDetectAuto / DuplicateDetectOff / defaultDuplicateThreshold
// のミラー (#136)。TS 側 (settings UI / useDuplicateCheck の gate) はこのモジュールを読む。
// 両側は test 対の pin 断言だけで同期される (Go は TestDuplicateDetectValues、TS は
// duplicateDetect.test.ts) ので、片側だけ変えると CI が落ちる (AGENTS.md D-1、watchMode.ts と
// 同流儀)。アルゴリズム定数 ("dhash" / "phash") は Phase 2 で加わる (spec-duplicate-detection.md §12)。
export const DUPLICATE_DETECT_AUTO = "auto" as const;
export const DUPLICATE_DETECT_OFF = "off" as const;

export type DuplicateDetectMode =
  | typeof DUPLICATE_DETECT_AUTO
  | typeof DUPLICATE_DETECT_OFF;

export const DUPLICATE_DETECT_VALUES: readonly DuplicateDetectMode[] = [
  DUPLICATE_DETECT_AUTO,
  DUPLICATE_DETECT_OFF,
];

export const DEFAULT_DUPLICATE_THRESHOLD = 5;
export const MIN_DUPLICATE_THRESHOLD = 0;
export const MAX_DUPLICATE_THRESHOLD = 16;
