//go:build windows

package wintaskbar

import (
	_ "embed"
	"encoding/binary"
	"fmt"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"image-observer/internal/logging"
	"image-observer/internal/winhwnd"
)

//go:embed assets/prev.ico
var prevIco []byte

//go:embed assets/next.ico
var nextIco []byte

// Win32 定数。
const (
	wmCommand     = 0x0111
	wmApp         = 0x8000
	wmInitTaskbar = wmApp + 1 // Setup が PostMessage する初期登録トリガ (spec §3.2)

	thbnClicked = 0x1800 // THBN_CLICKED (WM_COMMAND の HIWORD)

	gwlpWndProc = ^uintptr(3) // GWLP_WNDPROC = -4 (uintptr の 2 の補数表現)

	clsctxInprocServer = 0x1

	// THUMBBUTTONMASK / THUMBBUTTONFLAGS
	thbIcon     = 0x2 // THB_ICON。0x1 は THB_BITMAP (イメージリストの iBitmap 用) — 取り違えると hIcon が無視される
	thbTooltip  = 0x4
	thbFlags    = 0x8
	thbfEnabled = 0x0

	smCxSmIcon = 49 // SM_CXSMICON
	smCySmIcon = 50 // SM_CYSMICON

	// ボタン ID。WM_COMMAND の LOWORD で返る。他のコマンド ID と被らない任意値。
	idPrev = 0xB149
	idNext = 0xB14A
)

// guid は Win32 GUID に対応。
type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidTaskbarList = guid{0x56FDF344, 0xFD6D, 0x11D0, [8]byte{0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90}}
	iidITaskbarList3 = guid{0xEA1AFB91, 0x9E28, 0x4B86, [8]byte{0x90, 0xE9, 0x9E, 0x9F, 0x8A, 0x5E, 0xEF, 0xAF}}
)

// thumbButton は Win32 THUMBBUTTON に対応。フィールド順とサイズを厳密に一致させる
// (hIcon の 8-byte アライメントで iBitmap 後に 4 byte パディングが入るのも C と同一)。
type thumbButton struct {
	dwMask  uint32
	iId     uint32
	iBitmap uint32
	hIcon   uintptr
	szTip   [260]uint16
	dwFlags uint32
}

var (
	modUser32                    = syscall.NewLazyDLL("user32.dll")
	modOle32                     = syscall.NewLazyDLL("ole32.dll")
	procGetWindowLongPtrW        = modUser32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW        = modUser32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW          = modUser32.NewProc("CallWindowProcW")
	procPostMessageW             = modUser32.NewProc("PostMessageW")
	procRegisterWindowMessageW   = modUser32.NewProc("RegisterWindowMessageW")
	procCreateIconFromResourceEx = modUser32.NewProc("CreateIconFromResourceEx")
	procGetSystemMetrics         = modUser32.NewProc("GetSystemMetrics")
	procCoCreateInstance         = modOle32.NewProc("CoCreateInstance")
)

// Wails は window を navigationCompleted (WebView2 のロード完了) まで表示しないため、goroutine で
// 走る OnStartup からの初回 trySetup は HWND 未発見になりうる。表示されるまで再試行する (spec §3.2)。
const (
	setupRetryInterval = 250 * time.Millisecond
	setupRetryMax      = 40 // × 250ms = 最長 10 秒で諦める (best-effort, D7)
)

// wndProc の thunk。syscall.NewCallback は解放不能仕様なので retry をまたいで 1 回だけ作る。
var wndProcThunk = syscall.NewCallback(wndProc)

// module state。Setup は process につき 1 回 (main.go OnStartup) しか呼ばれず、window の
// 破棄 = process 終了なので、意図的にリセット経路を持たない一方向 state (spec §8 / H-3)。
// subclass の解除も行わない。origWndProc だけは Setup goroutine で write / UI スレッドで read
// されるため atomic でアクセスする (他は「atomic store より前に write / wndProc 冒頭の
// atomic load より後に read」の順序保証に載せる)。
var (
	onSwitchCb             func(direction string)
	origWndProc            uintptr        // atomic.LoadUintptr / StoreUintptr でのみアクセス
	wmTaskbarButtonCreated uintptr        // RegisterWindowMessageW("TaskbarButtonCreated")
	taskbarPtr             unsafe.Pointer // ITaskbarList3* (UI スレッドで lazy init)
	hIconPrev, hIconNext   uintptr
	buttonsRegistered      bool // 初回登録成功済みか。wndProc (UI スレッド) 内でのみ読み書き — 同期不要
)

// Setup はサムネイルツールバーの配線を開始する (#149)。COM 操作はここでは行わず、PostMessage で
// wndProc (UI スレッド) に委譲する (spec §3.2)。Wails の OnStartup は goroutine で走り window の
// 表示 (navigationCompleted) より先に到達しうるため、初回試行で HWND が見つからなければ
// バックグラウンドで再試行する。ok=false は非 Windows ビルド (taskbar_other.go) と、再試行しても
// 無意味な即時失敗のみ。それ以外の失敗は best-effort: warn を残して機能無効のまま起動を続けさせる (D7)。
func Setup(onSwitch func(direction string)) (ok bool) {
	// TaskbarButtonCreated: タスクバーボタン生成時 (起動時 + explorer 再起動時) に届く登録
	// メッセージ。これを受けてボタンを (再) 登録するのが公式手順。
	// NUL を含まないリテラルなので UTF16PtrFromString の err は起きない。
	msgName, _ := syscall.UTF16PtrFromString("TaskbarButtonCreated")
	msgID, _, _ := procRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(msgName)))
	if msgID == 0 {
		logging.Warn("wintaskbar", "RegisterWindowMessageW failed; thumbnail toolbar disabled")
		return false
	}
	wmTaskbarButtonCreated = msgID
	onSwitchCb = onSwitch

	if trySetup() {
		return true
	}
	go func() {
		for range setupRetryMax {
			time.Sleep(setupRetryInterval)
			if trySetup() {
				return
			}
		}
		logging.Warn("wintaskbar", "main window not found after retries; thumbnail toolbar disabled")
	}()
	return true
}

// trySetup は HWND 探索 → 旧 wndproc の atomic 公開 → subclass 装着 → 初期登録 PostMessage を
// 1 回試みる。単一 goroutine (Setup 呼び出し元 or retry loop) から直列に呼ばれるため二重装着はない。
func trySetup() bool {
	hwnd, found := winhwnd.FindMainWindow()
	if !found {
		// window が navigationCompleted 前で未表示のケース。retry が控えているので debug 止まり。
		logging.Debug("wintaskbar", "main window HWND not found yet; will retry")
		return false
	}

	// swap の「前」に旧 wndproc を取得して atomic で公開する。SetWindowLongPtrW の戻り値を代入する
	// 方式だと、カーネル内で swap が完了した瞬間から UI スレッドが新 wndProc に入れるのに
	// origWndProc がまだ 0 の隙間ができ、CallWindowProcW(NULL) (未定義動作) になりうる。
	// atomic store は先行 write (onSwitchCb / wmTaskbarButtonCreated) の可視化も保証する
	// (wndProc 側は冒頭の atomic load が対になる)。
	prev, _, errno := procGetWindowLongPtrW.Call(hwnd, gwlpWndProc)
	if prev == 0 {
		logging.Warn("wintaskbar", "GetWindowLongPtrW failed; thumbnail toolbar disabled", "err", errno.Error())
		return false
	}
	atomic.StoreUintptr(&origWndProc, prev)

	if ret, _, errno := procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, wndProcThunk); ret == 0 {
		logging.Warn("wintaskbar", "SetWindowLongPtrW(GWLP_WNDPROC) failed; thumbnail toolbar disabled",
			"err", errno.Error())
		return false
	}

	// subclass 装着前に TaskbarButtonCreated が発火済みの場合の取りこぼし対策 + 初期登録を
	// UI スレッドへ委譲。PostMessage 失敗は次の TaskbarButtonCreated (explorer 再起動時) 頼み。
	if ret, _, errno := procPostMessageW.Call(hwnd, wmInitTaskbar, 0, 0); ret == 0 {
		logging.Warn("wintaskbar", "PostMessageW(wmInitTaskbar) failed", "err", errno.Error())
	}
	return true
}

// wndProc は subclass 後の window procedure。自分宛て以外は必ず元の wndproc へ素通しする。
// UI スレッド (Wails のメッセージループ) 上で呼ばれる。
func wndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	// 冒頭の atomic load が trySetup の atomic store と対になり、先行 write
	// (onSwitchCb / wmTaskbarButtonCreated) の可視性を保証する。store は subclass 装着より
	// 前に済んでいるため、この関数が呼ばれる時点で orig は必ず非 0。
	orig := atomic.LoadUintptr(&origWndProc)
	switch {
	case msg == wmInitTaskbar || msg == wmTaskbarButtonCreated:
		// explorer 再起動でタスクバー側の登録は消えるため「登録済み flag」では gate せず
		// 受信のたびに再登録する (冪等化, spec §8 経路 2)。戻りは元 wndproc にも流す
		// (TaskbarButtonCreated を Wails 側が見る可能性を残しても害がない)。
		addButtons(hwnd)
	case msg == wmCommand && (wparam>>16)&0xFFFF == thbnClicked:
		switch wparam & 0xFFFF {
		case idPrev:
			notifySwitch(DirectionPrev)
			return 0
		case idNext:
			notifySwitch(DirectionNext)
			return 0
		}
	}
	ret, _, _ := procCallWindowProcW.Call(orig, hwnd, msg, wparam, lparam)
	return ret
}

// notifySwitch はクリックをアプリへ通知する。goroutine に逃がして wndProc を即 return させる
// (EventsEmit がメッセージループ上で再入・ブロックする余地を作らない)。イベントの消失
// (FE 未 ready) は許容 (spec §8 経路 3)。
func notifySwitch(direction string) {
	if onSwitchCb == nil {
		return
	}
	go onSwitchCb(direction)
}

// addButtons は ITaskbarList3 を lazy init してツールバーボタンを登録する。wndProc 内 =
// UI スレッドからのみ呼ばれる (COM は WebView2 が STA 初期化済みのこのスレッドに限定, spec §3.2)。
func addButtons(hwnd uintptr) {
	if taskbarPtr == nil {
		var ptr unsafe.Pointer
		hr, _, _ := procCoCreateInstance.Call(
			uintptr(unsafe.Pointer(&clsidTaskbarList)),
			0,
			clsctxInprocServer,
			uintptr(unsafe.Pointer(&iidITaskbarList3)),
			uintptr(unsafe.Pointer(&ptr)),
		)
		if hr != 0 {
			logging.Warn("wintaskbar", "CoCreateInstance(TaskbarList) failed", "hr", hresult(hr))
			return
		}
		// ITaskbarList3::HrInit (vtable 3)
		if hr := comCall(ptr, 3); hr != 0 {
			logging.Warn("wintaskbar", "ITaskbarList3.HrInit failed", "hr", hresult(hr))
			comCall(ptr, 2) // Release — 次のメッセージで作り直す
			return
		}
		taskbarPtr = ptr
	}

	if hIconPrev == 0 {
		hIconPrev = loadIcon(prevIco)
	}
	if hIconNext == 0 {
		hIconNext = loadIcon(nextIco)
	}
	if hIconPrev == 0 || hIconNext == 0 {
		logging.Warn("wintaskbar", "button icon load failed; skipping toolbar registration")
		return
	}

	buttons := [2]thumbButton{
		{dwMask: thbIcon | thbTooltip | thbFlags, iId: idPrev, hIcon: hIconPrev, dwFlags: thbfEnabled},
		{dwMask: thbIcon | thbTooltip | thbFlags, iId: idNext, hIcon: hIconNext, dwFlags: thbfEnabled},
	}
	setTip(&buttons[0], "前のビューア")
	setTip(&buttons[1], "次のビューア")

	// ITaskbarList3::ThumbBarAddButtons (vtable 15)。debug に落とすのは「一度成功した後の
	// 再登録エラー」(経路 2 の冪等化の正常系) だけ。一度も成功していない失敗 (E_INVALIDARG 等)
	// は既定 INFO レベルで見える warn にしないと、ボタンが出ない障害が無痕跡になる (spec §10)。
	if hr := comCall(taskbarPtr, 15, hwnd, 2, uintptr(unsafe.Pointer(&buttons[0]))); hr != 0 {
		if buttonsRegistered {
			logging.Debug("wintaskbar", "ThumbBarAddButtons returned non-zero on re-add (already added?)", "hr", hresult(hr))
		} else {
			logging.Warn("wintaskbar", "ThumbBarAddButtons failed on first registration", "hr", hresult(hr))
		}
		return
	}
	buttonsRegistered = true
	logging.Info("wintaskbar", "thumbnail toolbar buttons registered")
}

// comCall は COM インターフェイスポインタの vtable index を呼ぶ (this を先頭引数に補う)。
// this を uintptr で受けると vet (unsafeptr) が弾くため unsafe.Pointer のまま扱う。
func comCall(this unsafe.Pointer, vtblIndex int, args ...uintptr) uintptr {
	vtbl := *(**[32]uintptr)(this)
	callArgs := append([]uintptr{uintptr(this)}, args...)
	ret, _, _ := syscall.SyscallN(vtbl[vtblIndex], callArgs...)
	return ret
}

// loadIcon は .ico バイト列から小アイコンサイズ (SM_CXSMICON) に最も近いエントリを選び
// HICON 化する。失敗は 0。ICO ファイルの ICONDIR はリソース形式 (GRPICONDIR) と
// エントリレイアウトが違うため LookupIconIdFromDirectoryEx は使えず自前で走査する。
func loadIcon(ico []byte) uintptr {
	cx, _, _ := procGetSystemMetrics.Call(smCxSmIcon)
	cy, _, _ := procGetSystemMetrics.Call(smCySmIcon)
	entry, ok := pickIconEntry(ico, int(cx))
	if !ok {
		logging.Warn("wintaskbar", "no usable entry in embedded ico")
		return 0
	}
	// dwVer 0x00030000 固定 (Win32 icon resource format のバージョン)。
	hicon, _, errno := procCreateIconFromResourceEx.Call(
		uintptr(unsafe.Pointer(&entry[0])),
		uintptr(len(entry)),
		1, // fIcon
		0x00030000,
		cx,
		cy,
		0,
	)
	if hicon == 0 {
		logging.Warn("wintaskbar", "CreateIconFromResourceEx failed", "err", errno.Error())
	}
	return hicon
}

// pickIconEntry は ICO の ICONDIR を走査し、want px に最も近い幅のエントリの画像バイト列を返す。
func pickIconEntry(ico []byte, want int) ([]byte, bool) {
	if len(ico) < 6 {
		return nil, false
	}
	count := int(binary.LittleEndian.Uint16(ico[4:6]))
	best := -1
	bestDiff := 1 << 30
	for i := range count {
		off := 6 + 16*i
		if off+16 > len(ico) {
			return nil, false
		}
		w := int(ico[off])
		if w == 0 {
			w = 256
		}
		diff := w - want
		if diff < 0 {
			diff = -diff
		}
		if diff < bestDiff {
			bestDiff = diff
			best = off
		}
	}
	if best < 0 {
		return nil, false
	}
	size := int(binary.LittleEndian.Uint32(ico[best+8 : best+12]))
	imgOff := int(binary.LittleEndian.Uint32(ico[best+12 : best+16]))
	if imgOff < 0 || size <= 0 || imgOff+size > len(ico) {
		return nil, false
	}
	return ico[imgOff : imgOff+size], true
}

// setTip は szTip に NUL 終端 UTF-16 を書き込む。
func setTip(b *thumbButton, tip string) {
	u, err := syscall.UTF16FromString(tip)
	if err != nil || len(u) > len(b.szTip) {
		return // 不正文字列は tooltip 無しで続行 (ボタン自体は機能する)
	}
	copy(b.szTip[:], u)
}

// hresult は HRESULT をログ用 16 進表記にする。
func hresult(hr uintptr) string {
	return fmt.Sprintf("0x%08X", uint32(hr))
}
