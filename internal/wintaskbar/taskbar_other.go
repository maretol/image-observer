//go:build !windows

package wintaskbar

// Setup は非 Windows ビルドでは no-op (#149)。サムネイルツールバーは Windows タスクバー
// 固有機能で、非 Windows に相当機能を作る予定もないため ok=false を返すだけ。
// onSwitch は保持も呼び出しもしない。caller (main.go) は ok=false を静かに無視する
// (winplacement.Restore の fallback と違い、代替経路が無い)。
func Setup(onSwitch func(direction string)) (ok bool) {
	return false
}
