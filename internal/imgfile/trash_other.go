//go:build !windows

package imgfile

import (
	"os"

	"image-observer/internal/logging"
)

// Trash deletes `absPath` outright via os.Remove on non-Windows builds.
//
// The production target is Windows only; this fallback exists so the
// app builds and runs in WSL/Linux for development (CLAUDE.md notes
// `wails dev` / `wails build` on Linux is supported as a dev target).
// On Linux this is a *hard* delete — files do not go to a system trash —
// so a warn log is emitted to make accidental dev-mode deletions traceable.
func Trash(absPath string) error {
	logging.Warn("imgfile", "trash: dev fallback to os.Remove (non-windows build)",
		"path", absPath)
	return os.Remove(absPath)
}
