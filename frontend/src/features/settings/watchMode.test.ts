import { describe, expect, it } from "vitest";
import {
  WATCH_MODE_AUTO,
  WATCH_MODE_OFF,
  WATCH_MODE_VALUES,
} from "./watchMode";

// AGENTS.md D-1 drift detector: these literals are duplicated in Go-side
// `internal/settings.WatchModeAuto` / `WatchModeOff` (locked there by
// `TestWatchModeValues`). Renaming one side without the other lets the
// settings UI persist a value that Validate then rejects, silently snapping
// the user's choice back to the default.
describe("watchMode constants", () => {
  it("WATCH_MODE_AUTO is the literal 'auto'", () => {
    expect(WATCH_MODE_AUTO).toBe("auto");
  });

  it("WATCH_MODE_OFF is the literal 'off'", () => {
    expect(WATCH_MODE_OFF).toBe("off");
  });

  it("WATCH_MODE_VALUES enumerates exactly the allowed values", () => {
    expect(WATCH_MODE_VALUES).toEqual(["auto", "off"]);
  });
});
