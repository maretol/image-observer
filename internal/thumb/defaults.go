package thumb

import "runtime"

// v1 defaults. Will be replaced by a settings module in Phase H (per spec-thumbnail.md §3.8).
var (
	defaultDisplaySize  = 256
	defaultMode         = "letterbox"
	generateScaleFactor = 2
	jpegQuality         = 85
)

// maxAutoWorkers caps the auto (NumCPU/2) worker count so a very large NUMA
// host does not end up with a pool wider than the explicit-setting upper
// bound (internal/settings.maxThumbnailWorkerCount = 64). Keeping the auto
// branch and the explicit branch on the same ceiling makes the "auto vs
// explicit" choice a true choice — without this, auto could silently spawn
// more workers than any value the user could type into the settings UI.
const maxAutoWorkers = 64

func defaultWorkerCount() int {
	n := runtime.NumCPU() / 2
	if n < 1 {
		n = 1
	}
	if n > maxAutoWorkers {
		n = maxAutoWorkers
	}
	return n
}
