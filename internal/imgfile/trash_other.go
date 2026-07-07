//go:build !windows

package imgfile

import (
	"os"

	"image-observer/internal/logging"
)

// Trash は non-Windows build では os.Remove で直接削除する (WSL/Linux 開発用 fallback, CLAUDE.md)。
// system trash を経ない hard delete なので、誤削除を追跡できるよう warn ログを出す。
func Trash(absPath string) error {
	logging.Warn("imgfile", "trash: dev fallback to os.Remove (non-windows build)",
		"path", absPath)
	return os.Remove(absPath)
}
