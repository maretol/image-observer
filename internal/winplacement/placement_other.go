//go:build !windows

package winplacement

import "image-observer/internal/state"

// Restore is a no-op on non-Windows builds: it reports ok=false so the caller
// (main.go OnStartup) falls back to the Wails-runtime restore path (issue #86).
// The argument is accepted and ignored so the call site is identical across
// platforms.
func Restore(_ state.WindowState) (ok bool) { return false }

// Capture is a no-op on non-Windows builds: ok=false tells the caller
// (main.go OnBeforeClose) not to persist a window placement here — the frontend
// geometry polling owns the window field on non-Windows (issue #86).
func Capture() (s state.WindowState, ok bool) { return state.WindowState{}, false }
