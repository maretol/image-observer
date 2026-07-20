//go:build !windows

package wintaskbar

import "testing"

// 非 Windows (dev/CI) ビルドの Setup は「何もせず ok=false、callback も呼ばない」契約 (#149)。
// Win32/COM の実経路は CI で動かせないため Windows 実機で手動検証し (PR test plan)、
// Linux CI ではこの no-op 契約だけを pin する (#133 restart_other_test.go と同じ流儀)。
func TestSetupIsNoopOnNonWindows(t *testing.T) {
	called := false
	if ok := Setup(func(string) { called = true }); ok {
		t.Fatal("Setup() on non-windows = true, want false")
	}
	if called {
		t.Fatal("Setup() on non-windows must not invoke onSwitch")
	}
}

// イベント名 / direction 値はフロント (frontend/src/taskbarEvents.ts) が hand-mirror する
// 契約値 (spec §4)。リネームでフロントとの D-1 同値が silent に壊れないよう値そのものを pin。
func TestEventContractValues(t *testing.T) {
	if ViewerSwitchEvent != "taskbar:viewer-switch" {
		t.Fatalf("ViewerSwitchEvent = %q", ViewerSwitchEvent)
	}
	if DirectionPrev != "prev" || DirectionNext != "next" {
		t.Fatalf("directions = %q / %q, want prev / next", DirectionPrev, DirectionNext)
	}
}
