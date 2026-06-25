//go:build !windows

package winrestart

// Register is a no-op on non-Windows builds: there is no RegisterApplicationRestart
// equivalent we target yet, and the production target is Windows only. It reports
// success (nil) so main.go's startup does not log a spurious failure on the
// WSL/Linux dev target. A future per-OS restart-on-failure mechanism slots in
// here behind its own build tag without changing the call site (issue #133).
func Register() error { return nil }
