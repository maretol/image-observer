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
// 第 2 戻り値は各 path の mtime (Unix 秒、#144 の mtime ソート入力)。walk 中の DirEntry.Info()
// から拾う (Windows ではディレクトリ列挙データ由来で追加 syscall なし)。Info() 失敗
// (コピー中ロック等) の path は map に行を持たず、エラーにしない。
type FileScanner interface {
	ListImageFiles(folderPath string) ([]string, map[string]int64, error)
}

// NewFileScanner は filepath.WalkDir を使う既定 scanner を返す。
func NewFileScanner() FileScanner {
	return fsScanner{}
}

type fsScanner struct{}

func (fsScanner) ListImageFiles(folderPath string) ([]string, map[string]int64, error) {
	// root 自体が無い/読めないとき clean error を出す (でないと下の best-effort 分岐が飲み込む)。
	if _, err := os.Stat(folderPath); err != nil {
		return nil, nil, fmt.Errorf("stat root: %w", err)
	}
	var out []string
	times := make(map[string]int64)
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
		posix := filepath.ToSlash(rel)
		out = append(out, posix)
		// mtime は walk 中の DirEntry から拾う (#144)。失敗は行なし (interface docstring 参照)。
		if info, err := d.Info(); err == nil {
			times[posix] = info.ModTime().Unix()
		}
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("walk dir: %w", err)
	}
	sort.Strings(out)
	return out, times, nil
}

// isHiddenName は先頭 "." の名前を hidden 扱いする。Windows の Hidden 属性は非対応 (稀なので許容)。
// sidecar (_classification.*) は "_" 始まりなので imgfile.IsImage フィルタ側で除外される。
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}
