// Package winplacement は Win32 Get/SetWindowPlacement で main window の geometry を保存/復元する (#129)。
//
// 専用 package の理由: Wails の runtime.WindowSetPosition は multi-monitor で primary monitor に復元して
// しまう。自前発見の HWND (EnumWindows + own-PID, placement_windows.go) に SetWindowPlacement を渡し
// 正しい monitor へ置く。rcNormalPosition は maximized 中でも restore rectangle なので frontend の
// geometry freeze polling (#86) が Windows では不要になる。
//
// platform 分割は imgfile.Trash と同様 (placement_windows.go = syscall 実装 / placement_other.go = no-op
// stub → non-Windows は caller が #86 fallback)。build tag 無しの変換 helper は Linux CI でも unit-test される。
package winplacement

import (
	"math"

	"image-observer/internal/state"
)

// ToWindowState は rcNormalPosition rect (Win32 RECT: right/bottom は exclusive edge) と maximized flag を
// state.WindowState に変換する。degenerate な extent (<200) はそのまま残す — clamp は state.Load の
// validateState に任せ、ここは純粋な座標変換に留める。
func ToWindowState(left, top, right, bottom int, maximized bool) state.WindowState {
	return state.WindowState{
		X:         left,
		Y:         top,
		Width:     right - left,
		Height:    bottom - top,
		Maximized: maximized,
	}
}

// FromWindowState は ToWindowState の逆で、SetWindowPlacement 用に RECT edge と maximized flag を返す。
// 各 edge は int32 range に saturate するので syscall が wrap 値を見ることは無い。X+Width / Y+Height は
// 壊れた state.json では int64 overflow しうるため clampSumInt32 で加算する。
func FromWindowState(s state.WindowState) (left, top, right, bottom int32, maximized bool) {
	return clampInt32(s.X), clampInt32(s.Y),
		clampSumInt32(s.X, s.Width), clampSumInt32(s.Y, s.Height),
		s.Maximized
}

// clampInt32 は Go int を int32 range に saturate する。無チェックの int32() 変換は壊れた state.json の
// 範囲外値を wrap (sign-flip) させ window を異常座標に置く。build tag 無しで Linux CI で unit-test される。
func clampInt32(v int) int32 {
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	return int32(v)
}

// clampSumInt32 は a+b を int64 overflow 無しで int32 range に saturate する。各項を先に int32 clamp する
// ので和は int64 に必ず収まり、raw な `s.X + s.Width` が clampInt32 前に overflow して wrap する穴を塞ぐ (#129)。
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
