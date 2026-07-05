package classification

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"image-observer/internal/imgfile"
)

// FileScanner はフォルダ配下の画像を再帰列挙し、root からの相対 POSIX path を返す ("child1/x.png")。
// symlink は辿らず (inode 追跡 / loop 検出が不要)、hidden dir (先頭 ".") は skip。
type FileScanner interface {
	ListImageFiles(folderPath string) ([]string, error)
}

// NewFileScanner は filepath.WalkDir を使う既定 scanner を返す。
func NewFileScanner() FileScanner {
	return fsScanner{}
}

type fsScanner struct{}

func (fsScanner) ListImageFiles(folderPath string) ([]string, error) {
	// root 自体が無い/読めないとき clean error を出す (でないと下の best-effort 分岐が飲み込む)。
	if _, err := os.Stat(folderPath); err != nil {
		return nil, fmt.Errorf("stat root: %w", err)
	}
	var out []string
	err := filepath.WalkDir(folderPath, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// best-effort: この entry は skip し兄弟の walk は続ける。
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path == folderPath {
			return nil // root 自身
		}
		name := d.Name()
		if isHiddenName(name) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !imgfile.IsImage(name) {
			return nil
		}
		rel, err := filepath.Rel(folderPath, path)
		if err != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk dir: %w", err)
	}
	sort.Strings(out)
	return out, nil
}

// isHiddenName は先頭 "." の名前を hidden 扱いする。Windows の Hidden 属性は非対応 (稀なので許容)。
// sidecar (_classification.*) は "_" 始まりなので imgfile.IsImage フィルタ側で除外される。
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}
