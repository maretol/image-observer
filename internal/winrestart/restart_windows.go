//go:build windows

package winrestart

import (
	"fmt"
	"syscall"

	"image-observer/internal/logging"
)

// restartFlags is the dwFlags argument to RegisterApplicationRestart. We pass 0
// so Windows restarts the app after a crash, hang, patch install, or update
// reboot — the full Restartable App behavior we want (issue #133). To opt out of
// a single case, OR in the matching RESTART_NO_* bit:
//
//	RESTART_NO_CRASH=1, RESTART_NO_HANG=2, RESTART_NO_PATCH=4, RESTART_NO_REBOOT=8.
const restartFlags = 0

var (
	modKernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procRegisterApplicationRestart = modKernel32.NewProc("RegisterApplicationRestart")
)

// Register registers this process for automatic restart by Windows (issue #133).
// Returns nil on success, or an error describing the HRESULT on failure. The
// caller (main.go) treats failure as best-effort: it only means we will not be
// auto-relaunched, so it logs and continues.
func Register() error {
	// pwzCommandline = NULL (the first 0): the app is relaunched with no
	// arguments. RegisterApplicationRestart prepends the executable path itself,
	// and image-observer takes no CLI arguments, so there is nothing to pass.
	ret, _, _ := procRegisterApplicationRestart.Call(0, uintptr(restartFlags))
	// RegisterApplicationRestart returns an HRESULT; S_OK (0) means success. The
	// third .Call return (last-error) is not meaningful for an HRESULT-returning
	// function, so it is ignored above.
	if ret != 0 {
		return fmt.Errorf("winrestart: RegisterApplicationRestart returned HRESULT 0x%x", ret)
	}
	logging.Info("winrestart", "registered for automatic restart", "flags", restartFlags)
	return nil
}
