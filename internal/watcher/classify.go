package watcher

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/classification"
	"image-observer/internal/imgfile"
)

// classifyAndAccumulate inspects one raw fsnotify event and updates acc.
// Returns true iff the event should reset the debounce timer (i.e. it
// contributes something the frontend cares about).
//
// st is passed in so the function can incrementally Add new subdirectories
// for monitoring (via st.watcher) and consult/update st.watchedDirs to
// distinguish dir-vs-file Remove reliably (w.Remove's return value is
// timing-dependent — Linux inotify processes IN_IGNORED asynchronously).
// See spec §7.2.
func classifyAndAccumulate(acc *changedAccumulator, ev fsnotify.Event, st *watchState) bool {
	w := st.watcher
	base := filepath.Base(ev.Name)

	// Hidden filter applies to descendants only. The root itself is always
	// monitored — the user explicitly opened it via the folder picker.
	// Skipping the root here would drop its own Remove/Rename event when
	// the user picked a `.foo` directory, stranding the loop on a dead
	// inotify fd because the root-vanish branch would never fire.
	if ev.Name != st.root && isHiddenName(base) {
		return false
	}

	// Sidecar JSON: any non-chmod event flips the flag — UNLESS the path
	// is actually a directory named `_classification.json`. The
	// classification scanner ignores directories, so treating a same-named
	// dir as a sidecar would skip addSubtree on Create (descendants never
	// get watched) and skip removeSubtreeFromWatch on Remove (inode-tracked
	// watches leak). For Remove/Rename we consult st.watchedDirs (path is
	// already gone); for Create we Lstat (and explicitly ignore symlinks).
	// Fall through to the regular dir branches when the path is a dir.
	if base == classification.SidecarJSON {
		pathIsDir := false
		if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
			_, pathIsDir = st.watchedDirs[ev.Name]
		} else if ev.Op.Has(fsnotify.Create) {
			if info, err := os.Lstat(ev.Name); err == nil &&
				info.Mode()&os.ModeSymlink == 0 && info.IsDir() {
				pathIsDir = true
			}
		}
		if !pathIsDir {
			if ev.Op.Has(fsnotify.Create) || ev.Op.Has(fsnotify.Write) ||
				ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
				acc.sidecarChanged = true
				acc.anyChange = true
				return true
			}
			return false
		}
		// pathIsDir == true: fall through to the dir branches below.
	}

	if ev.Op == fsnotify.Chmod {
		return false
	}

	// New directory: Lstat (not Stat) to detect symlinks. addSubtree on a
	// symlink-to-external-dir would pull that whole tree into our watch
	// while the classification scanner does not follow symlinks, surfacing
	// events from paths the user never picked and breaking the
	// "current folder only" invariant. On a confirmed dir we walk it
	// recursively so:
	//   1) every nested subdirectory gets its own watch (Linux inotify has
	//      no native recursive mode — without this, a `mv` of an existing
	//      tree into the watched root would silently miss arbitrary
	//      descendants),
	//   2) image files already present (e.g. from `mv` / `cp -r`) are
	//      counted as added so the debounced payload accurately summarises
	//      the change.
	if ev.Op.Has(fsnotify.Create) {
		// If Lstat errors the path likely already vanished (rapid
		// create-then-remove); fall through to the regular file branches
		// below so the image classifier still has a chance to act.
		if info, err := os.Lstat(ev.Name); err == nil {
			isSymlink := info.Mode()&os.ModeSymlink != 0
			if isSymlink && !imgfile.IsImage(base) {
				// Symlink to a non-image (directory or other). We never
				// traverse the target. Flag anyChange so the user sees
				// something happened.
				acc.anyChange = true
				return true
			}
			// Image-extension symlinks fall through to the image Create
			// branch below — the classification scanner includes any path
			// with an image extension regardless of symlink status, so
			// bumping addedFiles here keeps the emitted payload consistent
			// with what the next re-Load surfaces.
			if !isSymlink && info.IsDir() {
				// Real directory: incremental add. Root failure here is
				// non-fatal (the parent dir's watch already gave us this
				// event; we just lose the new subdir's nested activity).
				// anyChange stays true so the frontend re-Loads.
				_, discovered := addSubtreeCollect(w, ev.Name, st.watchedDirs)
				if len(discovered) > 0 {
					if acc.discoveredImagePaths == nil {
						acc.discoveredImagePaths = make(map[string]struct{}, len(discovered))
					}
					// Dedup against the per-window shared set: a previous
					// dir-Create in the same debounce window may have
					// walked a parent that contained this path. Possible
					// when fsnotify fires both the parent and the
					// (concurrently created) child dir's Create events and
					// the parent walk reached the child first.
					newImages := 0
					for _, p := range discovered {
						if _, dup := acc.discoveredImagePaths[p]; dup {
							continue
						}
						acc.discoveredImagePaths[p] = struct{}{}
						newImages++
					}
					acc.addedFiles += newImages
				}
				acc.anyChange = true
				return true
			}
		}
	}

	// Below here we only care about image files for counters. A Remove or
	// Rename on a non-image, non-sidecar path is almost always either a
	// directory disappearing (Linux's IN_IGNORED fires on the dir's own
	// path with no extension) or a file the user is reorganising. Either
	// way the on-disk set changed enough to warrant a re-Load: flag
	// anyChange without bumping addedFiles / removedFiles (we can't tell
	// whether the path was an image-bearing subtree). Write / Chmod-only
	// on non-image paths stays ignored.
	if !imgfile.IsImage(base) {
		if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
			// Dedup against acc.removedPaths so IN_IGNORED /
			// IN_DELETE_SELF follow-ups don't re-trigger anyChange.
			if acc.removedPaths == nil {
				acc.removedPaths = make(map[string]struct{})
			}
			if _, dup := acc.removedPaths[ev.Name]; dup {
				return true
			}
			acc.removedPaths[ev.Name] = struct{}{}
			// Unwatch the path AND its descendants. Linux inotify tracks
			// watches by inode, so after a rename the descendant inodes
			// still belong to OUR watch set and would keep streaming
			// events labelled with the original path. Tombstone every
			// descendant we unwatch into acc.removedPaths so the
			// IN_DELETE_SELF follow-ups for them are absorbed by the dedup
			// above and never reach the image-file branch.
			removeSubtreeFromWatch(st, ev.Name, acc.removedPaths)
			acc.anyChange = true
			return true
		}
		return false
	}

	triggered := false
	if ev.Op.Has(fsnotify.Create) {
		// Consume the dedup entry instead of double-bumping if a recent
		// dir-Create's WalkDir already counted this path. One-shot — a
		// later genuine Create for the same path within the same window
		// (rare: file removed then re-created) still gets counted.
		if _, dup := acc.discoveredImagePaths[ev.Name]; dup {
			delete(acc.discoveredImagePaths, ev.Name)
		} else {
			acc.addedFiles++
		}
		triggered = true
	}
	if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
		// Per-window dedup: inotify fires parent's IN_DELETE plus the
		// path's own IN_DELETE_SELF + IN_IGNORED for a single removal.
		if acc.removedPaths == nil {
			acc.removedPaths = make(map[string]struct{})
		}
		if _, dup := acc.removedPaths[ev.Name]; dup {
			return true
		}
		acc.removedPaths[ev.Name] = struct{}{}
		// Detect dir-vs-file via st.watchedDirs (NOT w.Remove's return
		// value — that's timing-dependent because inotify processes
		// IN_IGNORED asynchronously and may have internally evicted the
		// watch by the time we hand-call w.Remove on the IN_DELETE).
		// If the path is in watchedDirs, it was a directory we'd added
		// (e.g. an image-extension dir like `photos.jpg/`). The
		// classification scanner ignores directories, so reporting
		// removedFiles++ here would over-report. Treat as anyChange.
		// For real image files we never Add'd, the path isn't in
		// watchedDirs → bump normally.
		if _, wasDir := st.watchedDirs[ev.Name]; wasDir {
			// Unwatch the whole subtree (image-extension dirs may have
			// arbitrary nested watched dirs whose inode-tracked watches
			// move out of the tree on rename). Tombstone the unwatched
			// descendants into acc.removedPaths so their own
			// IN_DELETE_SELF events are absorbed by the dedup above.
			removeSubtreeFromWatch(st, ev.Name, acc.removedPaths)
			acc.anyChange = true
		} else {
			acc.removedFiles++
			if ev.Op.Has(fsnotify.Rename) {
				acc.renamedFiles++
			}
		}
		triggered = true
	}
	// Write on an existing image leaves the entries set unchanged
	// (filename is still there) and the frontend's useGridThumbnail cache
	// is path-keyed so a content-only edit wouldn't refresh the displayed
	// thumbnail. Don't bump any counter, but DO reset the debounce timer
	// (return true) so a large image being copied
	// (Create → Write → Write → … sequence) keeps the quiet window alive
	// until the writes actually settle — otherwise the 200ms after Create
	// would flush prematurely and LoadClassification would surface the
	// file mid-write as a broken / size-0 image. Spec §7.2 / §13.14 covers
	// the Phase 2 cache-invalidation hook needed to surface content edits.
	if ev.Op.Has(fsnotify.Write) {
		triggered = true
	}
	return triggered
}

// isHiddenName mirrors the rule in internal/classification/scanner.go to
// keep watched and scanned trees in sync. Dotfile / dotdir only — the
// Windows-only hidden attribute is not consulted (deliberate v1 limit).
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}
