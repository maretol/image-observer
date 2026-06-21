//go:build windows

package winplacement

import (
	"syscall"
	"unsafe"

	"image-observer/internal/logging"
	"image-observer/internal/state"
)

// Win32 constants.
const (
	gwOwner = 4 // GetWindow's GW_OWNER: the window's owner (0 for true top-level)

	// WINDOWPLACEMENT.showCmd values we act on. A captured SW_SHOWMINIMIZED (2)
	// is intentionally not matched below: a minimized window is persisted as
	// non-maximized via its rcNormalPosition (D6), so we never reopen minimized.
	swShowNormal    = 1 // SW_SHOWNORMAL  — restored, normal position
	swShowMaximized = 3 // SW_SHOWMAXIMIZED
)

// point mirrors the Win32 POINT (two LONG = int32).
type point struct {
	X, Y int32
}

// rect mirrors the Win32 RECT. right / bottom are exclusive edges.
type rect struct {
	Left, Top, Right, Bottom int32
}

// windowPlacement mirrors the Win32 WINDOWPLACEMENT struct. Field order and
// sizes must match exactly for the syscall to read / write it correctly.
// `length` must be set to the struct size before Get/SetWindowPlacement.
type windowPlacement struct {
	length           uint32
	flags            uint32
	showCmd          uint32
	ptMinPosition    point
	ptMaxPosition    point
	rcNormalPosition rect
}

var (
	modUser32                    = syscall.NewLazyDLL("user32.dll")
	modKernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procEnumWindows              = modUser32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = modUser32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = modUser32.NewProc("IsWindowVisible")
	procGetWindow                = modUser32.NewProc("GetWindow")
	procGetWindowTextLengthW     = modUser32.NewProc("GetWindowTextLengthW")
	procGetWindowPlacement       = modUser32.NewProc("GetWindowPlacement")
	procSetWindowPlacement       = modUser32.NewProc("SetWindowPlacement")
	procGetCurrentProcessId      = modKernel32.NewProc("GetCurrentProcessId")
)

// findMainWindow locates this process's main top-level window HWND via
// EnumWindows (issue #129 / D1). Wails v2 does not expose the native handle,
// so we enumerate top-level windows and pick the first one that is:
//   - owned by our own process (GetWindowThreadProcessId == GetCurrentProcessId),
//   - visible (IsWindowVisible),
//   - a true top-level (GetWindow(GW_OWNER) == 0, i.e. has no owner window),
//   - and has a non-empty caption (GetWindowTextLengthW > 0),
//
// which excludes WebView2 helper / message-only windows. We deliberately do
// not match on the title string so a future WindowSetTitle does not break this
// (the title would otherwise be a second hard-coded copy — see AGENTS.md D-1).
//
// EnumWindows takes a syscall callback. We build it per call (findMainWindow
// runs at most twice per process: OnStartup restore + OnBeforeClose capture),
// so the tiny per-process callback allocation is irrelevant and we avoid any
// module-scoped result state (AGENTS.md H-3).
func findMainWindow() (hwnd uintptr, ok bool) {
	pid, _, _ := procGetCurrentProcessId.Call()
	var found uintptr
	cb := syscall.NewCallback(func(h uintptr, _ uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&wpid)))
		if uintptr(wpid) != pid {
			return 1 // not ours — keep enumerating
		}
		if visible, _, _ := procIsWindowVisible.Call(h); visible == 0 {
			return 1
		}
		if owner, _, _ := procGetWindow.Call(h, gwOwner); owner != 0 {
			return 1 // owned (dialog/popup) — not the main window
		}
		if length, _, _ := procGetWindowTextLengthW.Call(h); length == 0 {
			return 1 // caption-less helper window
		}
		found = h
		return 0 // stop enumeration
	})
	procEnumWindows.Call(cb, 0)
	return found, found != 0
}

// Restore applies the persisted geometry to the main window via
// SetWindowPlacement (issue #129). Returns ok=true when the placement was
// applied; ok=false (HWND not found / syscall failure) tells the caller to
// fall back to the Wails-runtime restore path (#86).
func Restore(s state.WindowState) (ok bool) {
	hwnd, found := findMainWindow()
	if !found {
		logging.Warn("winplacement", "main window HWND not found; falling back to runtime restore")
		return false
	}
	left, top, right, bottom, maximized := FromWindowState(s)
	wp := windowPlacement{
		showCmd: swShowNormal,
		rcNormalPosition: rect{
			Left:   clampInt32(left),
			Top:    clampInt32(top),
			Right:  clampInt32(right),
			Bottom: clampInt32(bottom),
		},
	}
	if maximized {
		// SetWindowPlacement maximizes the window while remembering
		// rcNormalPosition as the restore rectangle, so un-maximizing falls
		// back to the persisted non-maximized geometry (replaces #86's hack).
		wp.showCmd = swShowMaximized
	}
	wp.length = uint32(unsafe.Sizeof(wp))
	// .Call's third return is the Win32 last-error; include it so a real-machine
	// failure is diagnosable (it is only meaningful on the ret==0 failure path).
	if ret, _, errno := procSetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp))); ret == 0 {
		logging.Warn("winplacement", "SetWindowPlacement failed; falling back to runtime restore", "err", errno.Error())
		return false
	}
	return true
}

// Capture reads the main window's current placement via GetWindowPlacement
// (issue #129), to be called from OnBeforeClose while the window still exists.
// rcNormalPosition is the restore rectangle even when the window is currently
// maximized or minimized, so the captured geometry is always the non-maximized
// size. A minimized window is persisted as non-maximized (D6) — we never reopen
// minimized. Returns ok=false (HWND not found / syscall failure) so the caller
// skips the save.
func Capture() (s state.WindowState, ok bool) {
	hwnd, found := findMainWindow()
	if !found {
		logging.Warn("winplacement", "main window HWND not found; skipping placement capture")
		return state.WindowState{}, false
	}
	var wp windowPlacement
	wp.length = uint32(unsafe.Sizeof(wp))
	if ret, _, errno := procGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp))); ret == 0 {
		logging.Warn("winplacement", "GetWindowPlacement failed; skipping placement capture", "err", errno.Error())
		return state.WindowState{}, false
	}
	maximized := wp.showCmd == swShowMaximized
	return ToWindowState(
		int(wp.rcNormalPosition.Left),
		int(wp.rcNormalPosition.Top),
		int(wp.rcNormalPosition.Right),
		int(wp.rcNormalPosition.Bottom),
		maximized,
	), true
}
