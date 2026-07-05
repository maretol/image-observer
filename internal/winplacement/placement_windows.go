//go:build windows

package winplacement

import (
	"syscall"
	"unsafe"

	"image-observer/internal/logging"
	"image-observer/internal/state"
)

// Win32 定数。
const (
	gwOwner = 4 // GW_OWNER: window の owner (true top-level は 0)

	// SW_SHOWMINIMIZED (2) は意図的に扱わない: minimized も rcNormalPosition 経由で non-maximized として
	// 保存する (D6) ため minimized で開き直すことは無い。
	swShowNormal    = 1 // SW_SHOWNORMAL
	swShowMaximized = 3 // SW_SHOWMAXIMIZED
)

// point は Win32 POINT (two LONG = int32) に対応。
type point struct {
	X, Y int32
}

// rect は Win32 RECT に対応。right/bottom は exclusive edge。
type rect struct {
	Left, Top, Right, Bottom int32
}

// windowPlacement は Win32 WINDOWPLACEMENT に対応。フィールド順とサイズを厳密に一致させる必要がある。
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

// findMainWindow は EnumWindows でこの process の main top-level window HWND を探す (#129 / D1)。
// Wails v2 が native handle を公開しないため。判定条件は下の各 if を参照 (own-PID / visible / owner 無し /
// caption 有り)。title 文字列では match しない — WindowSetTitle で壊れる hard-code の二重化を避ける (D-1)。
// callback は呼び出しごとに生成し module scope の結果 state を避ける (H-3)。
func findMainWindow() (hwnd uintptr, ok bool) {
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

// Restore は保存 geometry を SetWindowPlacement で main window に適用する (#129)。ok=false (HWND 未発見 /
// syscall 失敗) は caller に Wails-runtime 復元 (#86) への fallback を促す。
func Restore(s state.WindowState) (ok bool) {
	hwnd, found := findMainWindow()
	if !found {
		logging.Warn("winplacement", "main window HWND not found; falling back to runtime restore")
		return false
	}
	// FromWindowState が各 edge を int32 saturate 済みなので rect はそのまま使える。
	left, top, right, bottom, maximized := FromWindowState(s)
	wp := windowPlacement{
		showCmd: swShowNormal,
		rcNormalPosition: rect{
			Left:   left,
			Top:    top,
			Right:  right,
			Bottom: bottom,
		},
	}
	if maximized {
		// rcNormalPosition を restore rectangle として保ちつつ maximize するので un-maximize で
		// 保存済み geometry に戻る (#86 の hack を置換)。
		wp.showCmd = swShowMaximized
	}
	wp.length = uint32(unsafe.Sizeof(wp))
	// 第 3 戻り値は Win32 last-error。実機での失敗を診断できるよう含める。
	if ret, _, errno := procSetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp))); ret == 0 {
		logging.Warn("winplacement", "SetWindowPlacement failed; falling back to runtime restore", "err", errno.Error())
		return false
	}
	return true
}

// Capture は GetWindowPlacement で main window の placement を読む (#129)。window がまだ存在する
// OnBeforeClose から呼ぶ。rcNormalPosition は maximized/minimized 中でも restore rectangle なので
// capture geometry は常に non-maximized サイズ (minimized も non-maximized 保存 = D6)。ok=false なら caller は
// 保存を skip する。
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
