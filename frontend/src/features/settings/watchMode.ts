// WATCH_MODE_AUTO / WATCH_MODE_OFF mirror Go-side
// `internal/settings.WatchModeAuto` / `WatchModeOff`. The settings UI segment
// values, the watcher lifecycle gate in useClassification, and the Go-side
// Validate path all read from this module so renaming either side without the
// other trips CI (AGENTS.md D-1). The companion test files
// (`watchMode.test.ts` on this side, `TestWatchModeValues` in Go) pin both
// literal strings.
export const WATCH_MODE_AUTO = "auto" as const;
export const WATCH_MODE_OFF = "off" as const;

export type WatchMode = typeof WATCH_MODE_AUTO | typeof WATCH_MODE_OFF;

export const WATCH_MODE_VALUES: readonly WatchMode[] = [
  WATCH_MODE_AUTO,
  WATCH_MODE_OFF,
];
