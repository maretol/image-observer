//go:build !windows

package winplacement

import "image-observer/internal/state"

// Restore は non-Windows では no-op。ok=false で caller を Wails-runtime 復元 (#86) に fallback させる。
func Restore(_ state.WindowState) (ok bool) { return false }

// Capture は non-Windows では no-op。ok=false で caller に placement 保存を skip させる (non-Windows は
// frontend polling が window field を持つ, #86)。
func Capture() (s state.WindowState, ok bool) { return state.WindowState{}, false }
