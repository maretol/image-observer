// Package wintaskbar は Windows タスクバーのサムネイルツールバー (ITaskbarList3) に
// 「前/次のビューア」ボタンを載せ、クリックをコールバックでアプリに通知する (#149)。
// Wails は import しない — 通知は Setup のコールバック注入で受け、main.go 側で
// runtime.EventsEmit に写す (watcher の EmitFunc と同じ依存方向)。
// 実体は taskbar_windows.go (//go:build windows)、非 Windows は taskbar_other.go の no-op。
package wintaskbar

// ViewerSwitchEvent はボタンクリックをフロントへ届ける EventsEmit のイベント名。
// payload は direction 文字列 (DirectionPrev | DirectionNext)。フロント側の hand-mirror は
// frontend/src/taskbarEvents.ts (D-1 pin テストで同値を固定)。
const ViewerSwitchEvent = "taskbar:viewer-switch"

// Direction 値。ViewerSwitchEvent の payload。
const (
	DirectionPrev = "prev"
	DirectionNext = "next"
)
