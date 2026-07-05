// Go 側 internal/settings.WatchModeAuto / WatchModeOff のミラー。TS 側 (settings UI /
// useClassification の watcher gate 等) はこのモジュールを読む。両側は test 対の pin 断言
// だけで同期される (Go の Validate はこのモジュールを読まない) ので、片側だけ rename すると
// settings UI が Validate に弾かれる値を永続化するのでなく CI が落ちる (AGENTS.md D-1)。
export const WATCH_MODE_AUTO = "auto" as const;
export const WATCH_MODE_OFF = "off" as const;

export type WatchMode = typeof WATCH_MODE_AUTO | typeof WATCH_MODE_OFF;

export const WATCH_MODE_VALUES: readonly WatchMode[] = [
  WATCH_MODE_AUTO,
  WATCH_MODE_OFF,
];
