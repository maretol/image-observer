package watcher

import (
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/imgfile"
	"image-observer/internal/logging"
)

// removeSubtreeFromWatch は watchedDirs のうち prefix と等しいか配下の path を全て unwatch する。
// watched dir が tree から消える (Remove / Rename) とき用 — 子孫を外さないと inode 追跡の watch が生き残り、
// rename が inode を tree 外へ動かしても元 path の event を受け続け「現 folder のみ」不変条件を破る。
// tombstone (非 nil なら) に unwatch した path を入れ、caller の removedPaths で子孫の後続 Remove/Rename が
// image-file 分岐に落ちて過剰計上するのを防ぐ。
func removeSubtreeFromWatch(st *watchState, prefix string, tombstone map[string]struct{}) {
	sep := string(filepath.Separator)
	prefixWithSep := prefix + sep
	for d := range st.watchedDirs {
		if d == prefix || strings.HasPrefix(d, prefixWithSep) {
			delete(st.watchedDirs, d)
			_ = st.watcher.Remove(d)
			if tombstone != nil {
				tombstone[d] = struct{}{}
			}
		}
	}
}

// addSubtree は root + 全非 hidden 子孫 dir を w に Add し、root を watch できたか返す (Start の初期列挙用、
// root 失敗は致命)。画像 path は返さない — Start 時は dedup 対象が無く、捨てる数千文字列の確保が大きい
// folder でメモリを跳ね上げるため。watchedDirs (非 nil なら) に Add 成功 dir を入れ dir/file 判別に使う。
// 子孫 Add 失敗は walk を止めず log + skip (部分カバレッジ > ゼロ)。
func addSubtree(w *fsnotify.Watcher, root string, watchedDirs map[string]struct{}) bool {
	rootAdded, _ := addSubtreeImpl(w, root, false, watchedDirs)
	return rootAdded
}

// addSubtreeCollect は per-event 版で、遭遇した画像の絶対 path も返す。監視中に *新規* dir が作られた
// ときだけ意味を持つ — caller が path を discoveredImagePaths に park し、WalkDir と race する並行 inotify
// Create が addedFiles を二重計上しないように。root 失敗は非致命 (親 dir の watch が event をくれる)。
func addSubtreeCollect(w *fsnotify.Watcher, root string, watchedDirs map[string]struct{}) (rootAdded bool, discovered []string) {
	return addSubtreeImpl(w, root, true, watchedDirs)
}

func addSubtreeImpl(w *fsnotify.Watcher, root string, collect bool, watchedDirs map[string]struct{}) (rootAdded bool, discovered []string) {
	// root を先に明示 Add し、caller が root 失敗と子孫失敗を区別できるように。
	if err := w.Add(root, fsnotify.All); err != nil {
		logging.Warn("watcher", "add root failed",
			"dir", root, "err", err.Error())
		return false, nil
	}
	if watchedDirs != nil {
		watchedDirs[root] = struct{}{}
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if p == root {
			// 上で明示的に追加済み。
			return nil
		}
		if isHiddenName(d.Name()) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if err := w.Add(p, fsnotify.All); err != nil {
				logging.Warn("watcher", "add dir failed",
					"dir", p, "err", err.Error())
			} else if watchedDirs != nil {
				watchedDirs[p] = struct{}{}
			}
			return nil
		}
		if collect && imgfile.IsImage(d.Name()) {
			discovered = append(discovered, p)
		}
		return nil
	})
	return true, discovered
}
