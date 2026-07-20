// タスクバーサムネイルツールバー (#149) の Go→FE イベント契約。
// Go 側 internal/wintaskbar/wintaskbar.go (ViewerSwitchEvent / DirectionPrev / DirectionNext)
// の hand-mirror (EventsEmit payload は Wails の型自動生成に乗らないため、context.md §4 A の
// watcherPolicy.ChangedPayload と同じ流儀)。同値は taskbarEvents.test.ts と Go 側
// taskbar_other_test.go の双方で pin して D-1 ドリフトを検知する。

export const TASKBAR_VIEWER_SWITCH_EVENT = "taskbar:viewer-switch";

export const TASKBAR_DIRECTION_PREV = "prev";
export const TASKBAR_DIRECTION_NEXT = "next";

export type TaskbarViewerSwitchDirection =
  | typeof TASKBAR_DIRECTION_PREV
  | typeof TASKBAR_DIRECTION_NEXT;

// EventsOn の payload は unknown で届くため型 guard で絞る (契約外の値は黙って捨てる)。
export function isTaskbarSwitchDirection(
  v: unknown,
): v is TaskbarViewerSwitchDirection {
  return v === TASKBAR_DIRECTION_PREV || v === TASKBAR_DIRECTION_NEXT;
}
