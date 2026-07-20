import { describe, expect, it } from "vitest";
import {
  isTaskbarSwitchDirection,
  TASKBAR_DIRECTION_NEXT,
  TASKBAR_DIRECTION_PREV,
  TASKBAR_VIEWER_SWITCH_EVENT,
} from "./taskbarEvents";

// Go 側 internal/wintaskbar/wintaskbar.go の定数との D-1 pin (#149)。Go 側は
// taskbar_other_test.go が同じ値を pin しており、どちらかを rename すると両側で落ちる。
describe("taskbarEvents — Go contract pin", () => {
  it("mirrors the wintaskbar constants", () => {
    expect(TASKBAR_VIEWER_SWITCH_EVENT).toBe("taskbar:viewer-switch");
    expect(TASKBAR_DIRECTION_PREV).toBe("prev");
    expect(TASKBAR_DIRECTION_NEXT).toBe("next");
  });

  it("isTaskbarSwitchDirection narrows only contract values", () => {
    expect(isTaskbarSwitchDirection("prev")).toBe(true);
    expect(isTaskbarSwitchDirection("next")).toBe(true);
    expect(isTaskbarSwitchDirection("up")).toBe(false);
    expect(isTaskbarSwitchDirection("")).toBe(false);
    expect(isTaskbarSwitchDirection(undefined)).toBe(false);
    expect(isTaskbarSwitchDirection(null)).toBe(false);
    // オブジェクト payload ({direction: "prev"} 形式) は契約外 — Go は素の文字列を emit する。
    expect(isTaskbarSwitchDirection({ direction: "prev" })).toBe(false);
  });
});
