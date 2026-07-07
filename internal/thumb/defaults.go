package thumb

import "runtime"

// v1 の既定。Phase H で settings module に置き換え予定 (spec-thumbnail.md §3.8)。
var (
	defaultDisplaySize  = 256
	defaultMode         = "letterbox"
	generateScaleFactor = 2
	jpegQuality         = 85
)

// maxAutoWorkers は auto (NumCPU/2) worker 数を cap する。settings.MaxThumbnailWorkerCount と同値に保ち、
// 大きい host でも auto が明示設定より多い worker を生まないように。TestThumbDefaultsMatchSettings が等価を守る。
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
