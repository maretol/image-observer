// Package winrestart registers the application as a "Restartable App" via the
// Win32 RegisterApplicationRestart API so Windows relaunches it automatically
// after a crash, hang, patch install, or an update-triggered reboot (issue #133).
//
// Combined with the existing session restore (internal/state) and window
// placement restore (internal/winplacement, #129), an automatic relaunch lands
// the user back on their previous viewers / tabs and window position — e.g.
// after a forced Windows Update reboot.
//
// Platform split mirrors internal/imgfile.Trash and internal/winplacement:
//   - restart_windows.go: the real syscall implementation (//go:build windows).
//   - restart_other.go:   a no-op stub returning nil (//go:build !windows) so the
//     app builds and runs on the WSL/Linux dev target. The issue asks to "keep it
//     implementable for other OSes in the future" — a future per-OS mechanism
//     (e.g. a systemd / launchd restart-on-failure unit) slots in behind its own
//     build tag without touching the call site in main.go.
//
// Notes on Windows behavior (not under our control):
//   - WER only relaunches the process if it ran for at least 60 seconds before
//     terminating abnormally, which avoids restart loops on a startup crash.
//   - A crash skips main.go's OnBeforeClose, so winplacement's geometry capture
//     (#129) does not run; an auto-restart then reopens at the last clean-exit
//     window placement. That is an acceptable degradation.
//   - We never call UnregisterApplicationRestart: a normal process exit clears
//     the registration on its own, and the registration is only consulted on
//     abnormal termination / reboot.
package winrestart
