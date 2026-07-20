//go:build windows

package winhwnd

import (
	"sync"
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

// enumProc の thunk。syscall.NewCallback は解放不能で windows の callback slot (~2000) を
// 恒久消費するため、呼び出しごとではなく package init で 1 回だけ作る (#149 レビュー)。
// 定期呼び出しする caller が現れても slot を食い潰さない。
var enumThunk = syscall.NewCallback(enumProc)

// enumProc が読み書きする検索 state。callback を 1 回生成にした代償の module state で、
// enumMu + FindMainWindow 冒頭の再初期化により呼び出しをまたぐ stale 値は残らない (H-3)。
var (
	enumMu    sync.Mutex
	enumPid   uintptr
	enumFound uintptr
)

func enumProc(h uintptr, _ uintptr) uintptr {
	var wpid uint32
	procGetWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&wpid)))
	if uintptr(wpid) != enumPid {
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
	enumFound = h
	return 0 // 列挙停止
}

// FindMainWindow は EnumWindows でこの process の main top-level window HWND を探す (#129 / D1)。
// Wails v2 が native handle を公開しないため。判定条件は enumProc の各 if を参照 (own-PID /
// visible / owner 無し / caption 有り)。title 文字列では match しない — WindowSetTitle で壊れる
// hard-code の二重化を避ける (D-1)。window は Wails の navigationCompleted まで不可視なので、
// それ以前の呼び出しは ok=false になる (caller 側で retry / fallback する)。
func FindMainWindow() (hwnd uintptr, ok bool) {
	enumMu.Lock()
	defer enumMu.Unlock()
	pid, _, _ := procGetCurrentProcessId.Call()
	enumPid = pid
	enumFound = 0
	procEnumWindows.Call(enumThunk, 0)
	return enumFound, enumFound != 0
}
