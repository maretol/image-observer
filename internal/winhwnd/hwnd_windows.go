//go:build windows

package winhwnd

import (
	"syscall"
	"unsafe"
)

// GW_OWNER: window の owner (true top-level は 0)。
const gwOwner = 4

var (
	modUser32                    = syscall.NewLazyDLL("user32.dll")
	modKernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procEnumWindows              = modUser32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = modUser32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = modUser32.NewProc("IsWindowVisible")
	procGetWindow                = modUser32.NewProc("GetWindow")
	procGetWindowTextLengthW     = modUser32.NewProc("GetWindowTextLengthW")
	procGetCurrentProcessId      = modKernel32.NewProc("GetCurrentProcessId")
)

// FindMainWindow は EnumWindows でこの process の main top-level window HWND を探す (#129 / D1)。
// Wails v2 が native handle を公開しないため。判定条件は下の各 if を参照 (own-PID / visible /
// owner 無し / caption 有り)。title 文字列では match しない — WindowSetTitle で壊れる hard-code の
// 二重化を避ける (D-1)。callback は呼び出しごとに生成し module scope の結果 state を避ける (H-3)。
func FindMainWindow() (hwnd uintptr, ok bool) {
	pid, _, _ := procGetCurrentProcessId.Call()
	var found uintptr
	cb := syscall.NewCallback(func(h uintptr, _ uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&wpid)))
		if uintptr(wpid) != pid {
			return 1 // 自分のではない — 列挙継続
		}
		if visible, _, _ := procIsWindowVisible.Call(h); visible == 0 {
			return 1
		}
		if owner, _, _ := procGetWindow.Call(h, gwOwner); owner != 0 {
			return 1 // owned (dialog/popup) — main window ではない
		}
		if length, _, _ := procGetWindowTextLengthW.Call(h); length == 0 {
			return 1 // caption 無し helper window
		}
		found = h
		return 0 // 列挙停止
	})
	procEnumWindows.Call(cb, 0)
	return found, found != 0
}
