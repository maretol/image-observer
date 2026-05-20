package watcher

import (
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/imgfile"
	"image-observer/internal/logging"
)

// removeSubtreeFromWatch unwatches every path in st.watchedDirs that is
// equal to or under `prefix`, calling w.Remove for each. Used when a
// watched directory disappears from the tree (Remove / Rename) — without
// removing descendants too, their inotify watches stay alive (Linux tracks
// them by inode), so a rename moves the watched inode out of our tree
// while we still receive its events labelled with the original path,
// violating the "current folder only" invariant. w.Remove errors are
// ignored (a watch may already have been auto-evicted via IN_IGNORED).
//
// `tombstone` (if non-nil) receives every unwatched path. The caller
// passes acc.removedPaths so any follow-up Remove / Rename event for a
// descendant arriving within the same debounce window hits the existing
// dedup guard instead of being misclassified — descendants like
// `photos.jpg/` (a directory with an image extension) would otherwise
// fall through to the image-file branch and over-count removedFiles once
// they've already been deleted from watchedDirs.
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

// addSubtree adds root + every non-hidden descendant directory to w and
// returns whether the root itself could be watched. Used by Start for the
// initial enumeration: root failure is fatal so the caller checks the bool
// and bails out. Image paths discovered during the walk are intentionally
// NOT returned — at Start time no inotify Create events are queued for
// them, so there is nothing to dedup against; allocating thousands of
// POSIX path strings just to discard them would spike memory on a large
// image folder.
//
// watchedDirs (if non-nil) is populated with every directory path
// successfully Add'd so the Remove / Rename handler can detect dir-vs-file
// reliably.
//
// Failures on descendant Add calls are logged and skipped rather than
// aborting the walk — partial coverage beats none.
func addSubtree(w *fsnotify.Watcher, root string, watchedDirs map[string]struct{}) bool {
	rootAdded, _ := addSubtreeImpl(w, root, false, watchedDirs)
	return rootAdded
}

// addSubtreeCollect is the per-event variant: in addition to adding
// watches it also returns the absolute paths of image files encountered.
// Only relevant when a *new* directory is created mid-watch — the caller
// parks the paths in changedAccumulator.discoveredImagePaths so a
// concurrent inotify Create racing with the WalkDir (e.g. a writer
// dropping files into the just-created dir) doesn't double-count
// addedFiles. Returns (rootAdded, discoveredImagePaths). Root failure is
// non-fatal at the call site: the parent dir's watch is what gave us the
// Create event, so we already have some visibility and only lose the new
// subdir's nested activity.
func addSubtreeCollect(w *fsnotify.Watcher, root string, watchedDirs map[string]struct{}) (rootAdded bool, discovered []string) {
	return addSubtreeImpl(w, root, true, watchedDirs)
}

func addSubtreeImpl(w *fsnotify.Watcher, root string, collect bool, watchedDirs map[string]struct{}) (rootAdded bool, discovered []string) {
	// Add root explicitly first so callers can distinguish "root failed"
	// from "some descendant failed".
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
			// Already added explicitly above.
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
