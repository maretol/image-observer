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
// Dependency direction: winplacement -> state (type only). state stays
// dependency-free; no cycle.
package winplacement

import "image-observer/internal/state"

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
// into a WINDOWPLACEMENT for SetWindowPlacement.
func FromWindowState(s state.WindowState) (left, top, right, bottom int, maximized bool) {
	return s.X, s.Y, s.X + s.Width, s.Y + s.Height, s.Maximized
}
