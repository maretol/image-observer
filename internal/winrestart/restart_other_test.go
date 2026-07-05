//go:build !windows

package winrestart

import "testing"

// On the non-Windows dev / CI build Register must be a no-op that reports success
// so main.go does not log a spurious "register application restart failed" at
// startup (issue #133). The real Win32 syscall path is verified manually on
// Windows (see the PR test plan); this test pins the no-op contract on Linux CI,
// where the kernel32 call cannot run.
func TestRegisterIsNoopOnNonWindows(t *testing.T) {
	if err := Register(); err != nil {
		t.Fatalf("Register() on non-windows = %v, want nil", err)
	}
}
