// WATCH_MODE_AUTO / WATCH_MODE_OFF mirror Go-side
// `internal/settings.WatchModeAuto` / `WatchModeOff`. The TS side of the
// codebase (settings UI segment values, the watcher lifecycle gate in
// useClassification, etc.) reads from THIS module so a one-sided rename on
// the TS side trips the local vitest assertion; the Go side keeps its own
// `WatchModeAuto` / `WatchModeOff` constants and ships a paired Go test
// (`TestWatchModeValues`) pinning the same literals. The two sides are
// kept in sync only by these test-pair pinning assertions — Go's `Validate`
// does NOT read this module — so renaming one side without the other trips
// CI rather than silently making the settings UI persist a value Validate
// rejects (AGENTS.md D-1).
export const WATCH_MODE_AUTO = "auto" as const;
export const WATCH_MODE_OFF = "off" as const;

export type WatchMode = typeof WATCH_MODE_AUTO | typeof WATCH_MODE_OFF;

export const WATCH_MODE_VALUES: readonly WatchMode[] = [
  WATCH_MODE_AUTO,
  WATCH_MODE_OFF,
];
