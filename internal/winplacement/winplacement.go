// Package winplacement persists and restores the main window's geometry using
// the Win32 GetWindowPlacement / SetWindowPlacement APIs (issue #129).
//
// Why a dedicated package: Wails v2 exposes no native window handle, and its
// runtime.WindowSetPosition restores the window onto the primary monitor on
// multi-monitor Windows (the bug this fixes — size and maximized state already
// restore, only the position is wrong). SetWindowPlacement takes the HWND we
// discover ourselves (EnumWindows + own-PID match, see placement_windows.go)
// and lands the window on the correct monitor. It also captures the restore
// rectangle (rcNormalPosition) atomically even while the window is maximized,
// so the frontend's "freeze geometry while maximized" polling hack (issue #86)
// is unnecessary on Windows.
//
// Platform split mirrors internal/imgfile.Trash:
//   - placement_windows.go: the real syscall implementation (//go:build windows).
//   - placement_other.go:   no-op stubs returning ok=false so callers fall back
//     to the Wails-runtime restore (#86) on non-Windows dev builds.
//
// The struct-conversion helpers in this file carry no build tag, so they are
// unit-tested on the Linux CI runner where the Win32 syscalls cannot run.
//
// Dependency direction: winplacement -> state (the state.WindowState type) and,
// on Windows builds only, -> logging (placement_windows.go emits warn logs).
// state stays dependency-free; no cycle.
package winplacement

import (
	"math"

	"image-observer/internal/state"
)

// ToWindowState converts a WINDOWPLACEMENT rcNormalPosition rectangle (Win32
// RECT: right/bottom are exclusive edges) plus a maximized flag into the
// persisted state.WindowState. Width / Height are derived from the rectangle.
// Degenerate extents (<200) are left as-is for state.Load's validateState to
// clamp on the next read — this helper stays a pure coordinate transform.
func ToWindowState(left, top, right, bottom int, maximized bool) state.WindowState {
	return state.WindowState{
		X:         left,
		Y:         top,
		Width:     right - left,
		Height:    bottom - top,
		Maximized: maximized,
	}
}

// FromWindowState is the inverse of ToWindowState: it yields the RECT edges
// (right / bottom computed from width / height) and the maximized flag to feed
// into a WINDOWPLACEMENT for SetWindowPlacement. Every edge is saturated into
// the int32 range the RECT fields require, so the syscall path never sees a
// wrapped value. right / bottom are X+Width / Y+Height, whose int64 sum could
// itself overflow for an absurdly corrupt state.json; clampSumInt32 adds in a
// domain that cannot overflow before saturating.
func FromWindowState(s state.WindowState) (left, top, right, bottom int32, maximized bool) {
	return clampInt32(s.X), clampInt32(s.Y),
		clampSumInt32(s.X, s.Width), clampSumInt32(s.Y, s.Height),
		s.Maximized
}

// clampInt32 saturates a Go int (int64 on 64-bit) into the int32 range a Win32
// RECT field requires. A corrupt or hand-edited state.json could hold a value
// outside int32; an unchecked int32() conversion would wrap (sign-flip) and
// place the window at a wild coordinate. Saturating instead keeps the value
// sane, and the OS still clamps the final placement to the visible work area.
// Lives in the build-tag-free file so it is unit-tested on the Linux CI runner.
func clampInt32(v int) int32 {
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	return int32(v)
}

// clampSumInt32 returns a+b saturated to the int32 range without int64
// overflow. Each addend is first clamped into int32, so the int64 sum of two
// int32-bounded values stays well within int64 before the final saturation —
// this closes the gap where a raw `s.X + s.Width` could overflow int64 and wrap
// before clampInt32 ever ran (issue #129 review). For in-range geometry the
// clamps are identities, so the sum is exact.
func clampSumInt32(a, b int) int32 {
	sum := int64(clampInt32(a)) + int64(clampInt32(b))
	if sum > math.MaxInt32 {
		return math.MaxInt32
	}
	if sum < math.MinInt32 {
		return math.MinInt32
	}
	return int32(sum)
}
