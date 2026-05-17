// Package watcher monitors a single folder (recursively) for file system
// changes that should refresh the classification ("list") tab UI. See
// docs/spec-folder-watch.md for the full design.
//
// The package wraps github.com/gofsnotify/fsnotify and adds:
//   - OS-agnostic recursive watching (Linux inotify and Windows ReadDirectoryChangesW
//     handled uniformly by enumerating subdirectories ourselves and Add'ing each)
//   - 200ms debounce + burst coalescing → a single emit() per quiet window
//   - filter that emits on: image-file Create/Remove/Rename, sidecar JSON
//     events, directory Create (with recursive Add of descendants), and
//     directory / non-image Remove/Rename (treated as anyChange so the
//     frontend re-Loads when a subtree disappears). Image-file Write events
//     do NOT emit on their own — counters stay unchanged — but they DO
//     extend the debounce timer so a large image's Create→Write→Write…
//     sequence keeps the quiet window open until the writes settle (see
//     spec §7.2 / classifyAndAccumulate for the Write branch). Chmod-only
//     and hidden paths are silently ignored.
//
// The watcher is *not* responsible for re-loading classification entries; it
// only signals that "something inside the folder changed". The frontend
// reloads via LoadClassification on receipt of the emitted payload.
package watcher

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/classification"
	"image-observer/internal/imgfile"
	"image-observer/internal/logging"
)

// DefaultDebounce is the quiet-window length applied before a coalesced event
// is flushed to the emit callback. Picked to absorb camera bulk-copy bursts
// (~100 files/sec) while keeping UI feedback brisk. See spec §7.3.
const DefaultDebounce = 200 * time.Millisecond

// ClassificationChangedEvent is the Wails event name used to push debounced
// changes from the Go watcher to the React frontend. It is duplicated on the
// frontend (`features/classification/useClassification.ts ::
// CLASSIFICATION_CHANGED_EVENT`); both sides ship a literal-equality test so
// a one-sided rename trips CI rather than slipping into a silent drift
// (AGENTS.md D-1).
const ClassificationChangedEvent = "classification:changed"

// ChangedPayload is the snapshot delivered to emit() (and onward to the
// frontend via Wails EventsEmit). Per-path detail is intentionally omitted —
// the frontend re-Loads the folder to get the authoritative entries.
type ChangedPayload struct {
	Folder         string `json:"folder"`
	AddedFiles     int    `json:"addedFiles"`
	RemovedFiles   int    `json:"removedFiles"`
	RenamedFiles   int    `json:"renamedFiles"`
	SidecarChanged bool   `json:"sidecarChanged"`
}

// EmitFunc is the callback the Manager invokes after each debounce flush.
// In production it's wired to runtime.EventsEmit; in tests it captures into
// a channel.
type EmitFunc func(ChangedPayload)

// Manager owns at most one active watch. Start/Stop are safe to call from
// multiple goroutines and Start may be called repeatedly with different
// roots — the previous watch is torn down first.
type Manager struct {
	emit     EmitFunc
	debounce time.Duration

	mu    sync.Mutex
	state *watchState // non-nil iff a watch is active
}

type watchState struct {
	watcher *fsnotify.Watcher
	root    string
	stop    chan struct{}
	done    chan struct{}

	// stopRequested is set true by stopLocked *before* closing the watcher.
	// The loop checks it on the Events-channel-closed path to decide
	// whether to flush pending events (explicit Stop = discard / treat
	// the close as user intent) versus log + flush (unexpected backend
	// failure). Reading from a different goroutine, hence atomic.
	stopRequested atomic.Bool
}

// NewManager constructs a Manager with the default debounce window.
func NewManager(emit EmitFunc) *Manager {
	return NewManagerWithDebounce(emit, DefaultDebounce)
}

// NewManagerWithDebounce is for tests / callers that need a custom flush
// window. Production code should use NewManager.
func NewManagerWithDebounce(emit EmitFunc, d time.Duration) *Manager {
	return &Manager{emit: emit, debounce: d}
}

// Start begins watching root. If a watch is already active on the same root
// with a live loop goroutine, this is a no-op. If a different root is active,
// or the previous loop has already exited (e.g. fsnotify backend died), the
// stale state is torn down first and a fresh watch is built.
//
// Returns an error if the root itself cannot be added to fsnotify; the
// caller degrades to manual reload in that case — see spec §5.5. Hidden
// subdirectories are skipped; non-fatal Add failures on visible
// descendants are logged and the walk continues (a partial watch beats
// none).
func (m *Manager) Start(root string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state != nil {
		// No-op only when the live goroutine is still running; otherwise
		// the state is a zombie (loop exited via watcher.Errors / Events
		// close) and we must rebuild. Checking via the done channel keeps
		// this lock-free on the loop side.
		if m.state.root == root && !goroutineExited(m.state) {
			return nil
		}
		_ = m.stopLocked()
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("watcher: NewWatcher: %w", err)
	}

	// Root must succeed: without it we can't see top-level changes (image
	// add/remove directly in `root`). Descendants are best-effort. The
	// initial walk doesn't need the discovered-image dedup set (that's
	// only relevant when a *new* directory is created mid-watch — the
	// dedup guards against a concurrent inotify Create racing with the
	// walk), so we use the collect-free overload to avoid allocating
	// thousands of POSIX path strings just to discard them when scanning
	// a large image folder (PR #75 8th, thread C).
	if !addSubtree(w, root) {
		_ = w.Close()
		return fmt.Errorf("watcher: cannot watch root %q", root)
	}

	st := &watchState{
		watcher: w,
		root:    root,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	m.state = st
	go m.loop(st)
	logging.Info("watcher", "started", "folder", root)
	return nil
}

// goroutineExited reports whether the loop for st has already returned.
// Used by Start to detect zombie states (loop ended via a backend-channel
// close without a paired Stop) so we don't no-op into a non-functional watch.
func goroutineExited(st *watchState) bool {
	select {
	case <-st.done:
		return true
	default:
		return false
	}
}

// Stop tears down the active watch (if any). Idempotent.
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopLocked()
}

func (m *Manager) stopLocked() error {
	if m.state == nil {
		return nil
	}
	st := m.state
	// Order matters here:
	//   1) Mark stopRequested so the loop's Events-channel-close branch
	//      can tell our explicit Stop from an unexpected backend failure.
	//   2) close(st.stop) signals the select to wake on the stop case
	//      directly — only useful if the loop is idle. If the loop is
	//      blocked in fsnotify's internal read, this alone doesn't help.
	//   3) st.watcher.Close() forces fsnotify to close Events/Errors, which
	//      unblocks the loop's select via the !ok branch.
	// Both 2) and 3) converge on the loop's defer close(done).
	//
	// Skipping close(st.stop) when it's already closed handles the zombie
	// path: Start saw a dead goroutine and called stopLocked to clean up.
	st.stopRequested.Store(true)
	select {
	case <-st.stop:
		// already closed (zombie cleanup) — st.watcher.Close still runs
		// to release fsnotify resources idempotently.
	default:
		close(st.stop)
	}
	err := st.watcher.Close()
	<-st.done
	logging.Info("watcher", "stopped", "folder", st.root)
	m.state = nil
	return err
}

// Current returns the root of the active watch, or "" when stopped. Used by
// tests / debug callers; production code should track the intended folder
// independently rather than poll this.
func (m *Manager) Current() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == nil {
		return ""
	}
	return m.state.root
}

// loop runs in its own goroutine for the duration of one watch. It coalesces
// raw fsnotify events into a single ChangedPayload per quiet window and
// invokes emit() exactly once per flush.
func (m *Manager) loop(st *watchState) {
	defer close(st.done)

	// errCh is captured into a local so we can set it to nil when fsnotify
	// closes the Errors channel — otherwise the closed channel stays
	// always-ready and `continue` produces a tight CPU loop.
	errCh := st.watcher.Errors

	var (
		timer   *time.Timer
		timerCh <-chan time.Time
		pending changedAccumulator
	)

	flush := func() {
		if pending.empty() {
			return
		}
		payload := pending.snapshot(st.root)
		pending.reset()
		m.emit(payload)
		logging.Debug("watcher", "flush",
			"folder", st.root,
			"added", payload.AddedFiles,
			"removed", payload.RemovedFiles,
			"renamed", payload.RenamedFiles,
			"sidecar", payload.SidecarChanged)
	}
	resetTimer := func() {
		if timer != nil {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(m.debounce)
		} else {
			timer = time.NewTimer(m.debounce)
		}
		timerCh = timer.C
	}

	for {
		select {
		case ev, ok := <-st.watcher.Events:
			if !ok {
				if timer != nil {
					timer.Stop()
				}
				// stopLocked sets stopRequested before triggering the
				// watcher.Close that drains this channel. Distinguish:
				//   - explicit Stop → discard pending (the user wanted
				//     monitoring off; a trailing flush would emit
				//     "classification:changed" after StopFolderWatch
				//     returned)
				//   - unexpected backend close (fsnotify died, max_watches
				//     overflow, etc.) → log + flush whatever we accumulated
				//     before exiting so the user at least gets the partial
				//     result; spec §10.2
				if !st.stopRequested.Load() {
					logging.Warn("watcher",
						"events channel closed unexpectedly",
						"folder", st.root)
					flush()
				}
				return
			}
			logging.Debug("watcher", "event",
				"op", ev.Op.String(), "path", ev.Name)
			if classifyAndAccumulate(&pending, ev, st.watcher) {
				resetTimer()
			}
			// Root vanished: a Remove / Rename on the watched root itself
			// (e.g. the user deleted or moved the folder out from under us)
			// leaves Linux inotify's watch dangling via IN_IGNORED; we'd
			// keep this goroutine alive forever waiting on a dead fd, and
			// since Manager.Start short-circuits on same-root + live
			// goroutine the next openFolder of the same path would also
			// no-op (PR #75 9th, thread F). Flush whatever was pending so
			// the frontend at least re-Loads (and surfaces the absence),
			// then tear down the fsnotify resources before exiting — leaving
			// the Watcher open until the next explicit Stop/Start would
			// leak its fd and reader goroutine for the entire window the
			// user spends in the now-orphaned folder (PR #75 10th, thread B).
			// stopLocked() detects `stopRequested` to remain idempotent if
			// the user happens to call Stop concurrently while the loop is
			// already on its way out.
			if (ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename)) && ev.Name == st.root {
				if timer != nil {
					timer.Stop()
				}
				logging.Warn("watcher", "watch root vanished",
					"folder", st.root, "op", ev.Op.String())
				pending.anyChange = true
				flush()
				// Mark stopRequested so the !ok branch above (which fires
				// once st.watcher.Close drains the Events channel) treats
				// the close as intentional and skips its log + flush
				// duplication. The actual goroutine termination is via
				// the `return` below — Close just releases fsnotify's
				// internal goroutine / fd.
				st.stopRequested.Store(true)
				_ = st.watcher.Close()
				return
			}
		case err, ok := <-errCh:
			if !ok {
				// fsnotify closed Errors. Don't return (Events may still
				// be live); just disable this case to avoid spinning.
				errCh = nil
				continue
			}
			logging.Warn("watcher", "channel error", "err", err.Error())
			// We can't reliably distinguish a benign warning from a
			// lost-event indicator (e.g. inotify IN_Q_OVERFLOW would
			// arrive here in some fsnotify forks). Be safe and flag
			// anyChange so the next flush prompts the frontend to
			// re-Load — without this, a queue overflow silently leaves
			// the listing stale even though we know our event stream
			// is incomplete (PR #75 review 7th, thread B).
			pending.anyChange = true
			resetTimer()
		case <-timerCh:
			timerCh = nil
			flush()
		case <-st.stop:
			if timer != nil {
				timer.Stop()
			}
			// Same rationale as the Events !ok branch above — explicit Stop
			// drops pending events. We arrive here when the stop signal
			// wins the select before watcher.Close drains the Events
			// channel.
			return
		}
	}
}

// changedAccumulator collects events between flushes. The boolean anyChange
// distinguishes "we got an interesting event that doesn't bump a counter"
// (e.g. a new subdirectory was created) from "no events at all", which lets
// empty() correctly suppress no-op emits.
//
// discoveredImagePaths is a per-window dedup set: when a directory-Create
// event runs addSubtree, every image file the walk turns up is both counted
// into addedFiles AND parked here. If inotify subsequently fires a Create
// for one of those paths (which can happen when the walk + watch-add races
// against a concurrent writer dropping files into the just-created dir),
// the image-Create branch consumes the entry instead of double-counting.
// The map is wiped by reset() at the end of each flush.
type changedAccumulator struct {
	addedFiles           int
	removedFiles         int
	renamedFiles         int
	sidecarChanged       bool
	anyChange            bool
	discoveredImagePaths map[string]struct{}
}

func (c *changedAccumulator) empty() bool {
	return !c.anyChange &&
		c.addedFiles == 0 &&
		c.removedFiles == 0 &&
		c.renamedFiles == 0 &&
		!c.sidecarChanged
}

func (c *changedAccumulator) reset() { *c = changedAccumulator{} }

func (c *changedAccumulator) snapshot(folder string) ChangedPayload {
	return ChangedPayload{
		Folder:         folder,
		AddedFiles:     c.addedFiles,
		RemovedFiles:   c.removedFiles,
		RenamedFiles:   c.renamedFiles,
		SidecarChanged: c.sidecarChanged,
	}
}

// classifyAndAccumulate inspects one raw fsnotify event and updates acc.
// Returns true iff the event should reset the debounce timer (i.e. it
// contributes something the frontend cares about).
//
// w is passed in so the function can incrementally Add new subdirectories
// for monitoring without round-tripping back through the loop.
func classifyAndAccumulate(acc *changedAccumulator, ev fsnotify.Event, w *fsnotify.Watcher) bool {
	base := filepath.Base(ev.Name)
	if isHiddenName(base) {
		return false
	}

	// Sidecar JSON: any non-chmod event flips the flag.
	if base == classification.SidecarJSON {
		if ev.Op.Has(fsnotify.Create) || ev.Op.Has(fsnotify.Write) ||
			ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
			acc.sidecarChanged = true
			acc.anyChange = true
			return true
		}
		return false
	}

	// Chmod-only carries no information for entries display.
	if ev.Op == fsnotify.Chmod {
		return false
	}

	// New directory: Lstat to confirm (Create on a regular file lands here too).
	// Use Lstat rather than Stat so we can detect symlinks without following
	// them — addSubtree on a symlink-to-external-dir would pull that whole
	// tree into our watch, while the classification scanner does not follow
	// symlinks, breaking the "current folder only" precondition and surfacing
	// events from paths the user never picked (PR #75 review 7th, thread A).
	// On a confirmed dir we walk it recursively so:
	//   1) every nested subdirectory gets its own watch (Linux inotify has no
	//      native recursive mode — without this, a `mv` of an existing tree
	//      into the watched root would silently miss arbitrary descendants),
	//   2) image files already present (e.g. from a `mv` / `cp -r`) are
	//      counted as added so the debounced payload accurately summarizes
	//      the change.
	if ev.Op.Has(fsnotify.Create) {
		// Lstat (not Stat) so we can detect symlinks. If Lstat errors the
		// path likely already vanished (rapid create-then-remove); just
		// fall through to the regular file branches below so the image
		// classifier still has a chance to act on a synthetic event.
		if info, err := os.Lstat(ev.Name); err == nil {
			isSymlink := info.Mode()&os.ModeSymlink != 0
			if isSymlink && !imgfile.IsImage(base) {
				// Symlink to a non-image (directory or other). We never
				// traverse the target (the classification scanner doesn't
				// follow symlinks either, so doing so here would surface
				// events from paths the user never picked). Flag anyChange
				// so the user sees something happened (PR #75 7th).
				acc.anyChange = true
				return true
			}
			// Image-extension symlinks intentionally fall through to the
			// regular image Create branch below — the classification
			// scanner includes any path with an image extension regardless
			// of symlink status (it uses Lstat-derived DirEntry and checks
			// extension only — see internal/classification/scanner.go:58-68),
			// so bumping addedFiles here keeps the emitted payload count
			// consistent with what the next re-Load surfaces in entries
			// (PR #75 8th, thread E).
			if !isSymlink && info.IsDir() {
				// Real directory: incremental add. Root-failure here is
				// non-fatal (the parent dir's watch is what gave us this
				// Create event, so we already have some visibility — we
				// just lose the new subdir's nested activity). anyChange
				// stays true so the frontend re-Loads.
				_, discovered := addSubtreeCollect(w, ev.Name)
				acc.addedFiles += len(discovered)
				if len(discovered) > 0 {
					if acc.discoveredImagePaths == nil {
						acc.discoveredImagePaths = make(map[string]struct{}, len(discovered))
					}
					// Park the just-counted paths so a concurrent inotify
					// Create (possible if a writer is dropping files into
					// the new dir while WalkDir is still running) doesn't
					// double-count.
					for _, p := range discovered {
						acc.discoveredImagePaths[p] = struct{}{}
					}
				}
				acc.anyChange = true
				return true
			}
		}
	}

	// Below here we only care about image files for the count. Non-image
	// files (e.g. `.txt`, `_classification.csv`, `.bak`) carry no entry
	// information — BUT a Remove or Rename on a non-image, non-sidecar path
	// is almost always either a directory disappearing (Linux's IN_IGNORED
	// fires on the dir's own path with no extension) or a file the user is
	// reorganising. Either way the on-disk set changed enough to warrant a
	// re-Load, so we flag anyChange without bumping addedFiles / removedFiles
	// (we can't tell whether the path was an image-bearing subtree). Write /
	// Chmod-only on non-image paths stays ignored.
	if !imgfile.IsImage(base) {
		if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
			// Drop the watch on the vanished path best-effort. On Linux
			// inotify a Rename of a watched subdirectory tracks the inode
			// (not the path), so without an explicit Remove the moved-out
			// subtree's later events would keep flowing into THIS root's
			// classification:changed stream — breaking the "current folder
			// only" contract (PR #75 review).
			_ = w.Remove(ev.Name)
			acc.anyChange = true
			return true
		}
		return false
	}

	triggered := false
	if ev.Op.Has(fsnotify.Create) {
		// If a recent dir-Create's WalkDir already counted this path,
		// consume the dedup entry instead of double-bumping addedFiles.
		// The entry is one-shot (delete after consume) so a later
		// genuine Create for the same path within the same window
		// (rare: file removed then re-created) still gets counted.
		if _, dup := acc.discoveredImagePaths[ev.Name]; dup {
			delete(acc.discoveredImagePaths, ev.Name)
		} else {
			acc.addedFiles++
		}
		triggered = true
	}
	if ev.Op.Has(fsnotify.Remove) {
		acc.removedFiles++
		// Best-effort drop of any inotify watch on this path. Image files
		// don't normally get watched (we only Add directories), but a
		// directory whose name happens to carry an image extension (e.g.
		// `photos.jpg/`) would land in this image branch — without an
		// explicit Remove, Linux inotify could keep the inode-tracked
		// watch alive and leak events from the moved-out subtree into
		// this root (PR #75 review). Idempotent for the common file case.
		_ = w.Remove(ev.Name)
		triggered = true
	}
	if ev.Op.Has(fsnotify.Rename) {
		// Rename at the source path is observationally a Remove. The
		// destination, if inside a watched dir on the same fs, surfaces as
		// a separate Create event. We count the Rename as a Remove for
		// entries math, plus a renamedFiles tick for informational purposes.
		acc.removedFiles++
		acc.renamedFiles++
		_ = w.Remove(ev.Name) // same defensive cleanup as Remove above
		triggered = true
	}
	// fsnotify.Write on an existing image leaves the entries set unchanged
	// (filename is still there) and the frontend's useGridThumbnail cache
	// is path-keyed so a content-only edit wouldn't refresh the displayed
	// thumbnail. We deliberately don't bump any counter for it — but we DO
	// reset the debounce timer (return true without bumping) so that a
	// large image being copied (Create → Write → Write → … sequence) keeps
	// the quiet window alive until the writes actually settle. Without this
	// the 200ms after Create would flush prematurely and the frontend would
	// LoadClassification while the file is still being written, surfacing
	// it as a broken / size-0 image (PR #75 review). Spec §7.2 / §13.14
	// covers the Phase 2 cache-invalidation hook needed to surface content
	// edits in the displayed thumbnail.
	if ev.Op.Has(fsnotify.Write) {
		triggered = true
	}
	return triggered
}

// isHiddenName mirrors the rule in internal/classification/scanner.go to keep
// watched and scanned trees in sync. Dotfile / dotdir only — Windows-only
// hidden attribute is not consulted (deliberate v1 limit).
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}

// addSubtree adds root + every non-hidden descendant directory to w and
// returns rootAdded (= whether the root itself could be watched).
// Used by Start for the initial enumeration: root failure is fatal so
// the caller checks the bool and bails out. Image paths discovered during
// the walk are intentionally NOT returned — at Start time no inotify
// Create events are queued for them, so there is nothing to dedup against;
// allocating thousands of POSIX path strings just to discard them would
// spike memory on a large image folder (PR #75 8th, thread C).
//
// Failures on descendant Add calls are logged and skipped rather than
// aborting the walk — partial coverage beats none.
func addSubtree(w *fsnotify.Watcher, root string) bool {
	rootAdded, _ := addSubtreeImpl(w, root, false)
	return rootAdded
}

// addSubtreeCollect is the per-event variant: in addition to adding watches
// it also returns the absolute paths of image files encountered. This is
// only relevant when a *new* directory is created mid-watch — the caller
// parks the paths in changedAccumulator.discoveredImagePaths so a
// concurrent inotify Create racing with the WalkDir (e.g. a writer dropping
// files into the just-created dir) doesn't double-count addedFiles.
// Returns (rootAdded, discoveredImagePaths). Root failure is non-fatal at
// the call site: the parent dir's watch is what gave us the Create event,
// so we already have some visibility and only lose the new subdir's nested
// activity.
func addSubtreeCollect(w *fsnotify.Watcher, root string) (rootAdded bool, discovered []string) {
	return addSubtreeImpl(w, root, true)
}

func addSubtreeImpl(w *fsnotify.Watcher, root string, collect bool) (rootAdded bool, discovered []string) {
	// Add root explicitly first so callers can distinguish "root failed"
	// from "some descendant failed".
	if err := w.Add(root, fsnotify.All); err != nil {
		logging.Warn("watcher", "add root failed",
			"dir", root, "err", err.Error())
		return false, nil
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
