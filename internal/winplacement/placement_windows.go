//go:build windows

package winplacement

import (
	"syscall"
	"unsafe"

	"image-observer/internal/logging"
	"image-observer/internal/state"
	"image-observer/internal/winhwnd"
)

// Win32 定数。
const (
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
	modUser32              = syscall.NewLazyDLL("user32.dll")
	procGetWindowPlacement = modUser32.NewProc("GetWindowPlacement")
	procSetWindowPlacement = modUser32.NewProc("SetWindowPlacement")
)

// Restore は保存 geometry を SetWindowPlacement で main window に適用する (#129)。ok=false (HWND 未発見 /
// syscall 失敗) は caller に Wails-runtime 復元 (#86) への fallback を促す。
func Restore(s state.WindowState) (ok bool) {
	hwnd, found := winhwnd.FindMainWindow()
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
	hwnd, found := winhwnd.FindMainWindow()
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
