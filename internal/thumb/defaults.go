package thumb

import "runtime"

// v1 defaults. Will be replaced by a settings module in Phase H (per spec-thumbnail.md §3.8).
var (
	defaultDisplaySize  = 256
	defaultMode         = "letterbox"
	generateScaleFactor = 2
	jpegQuality         = 85
)

func defaultWorkerCount() int {
	if n := runtime.NumCPU() / 2; n >= 1 {
		return n
	}
	return 1
}
