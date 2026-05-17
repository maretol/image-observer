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
//     frontend re-Loads when a subtree disappears). Everything else
//     (Write on existing files, Chmod-only, hidden paths) is silently
//     ignored.
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
	// add/remove directly in `root`). Descendants are best-effort.
	rootAdded, _ := addSubtree(w, root)
	if !rootAdded {
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
		case err, ok := <-errCh:
			if !ok {
				// fsnotify closed Errors. Don't return (Events may still
				// be live); just disable this case to avoid spinning.
				errCh = nil
				continue
			}
			logging.Warn("watcher", "channel error", "err", err.Error())
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
type changedAccumulator struct {
	addedFiles     int
	removedFiles   int
	renamedFiles   int
	sidecarChanged bool
	anyChange      bool
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

	// New directory: Stat to confirm (Create on a regular file lands here too).
	// On a confirmed dir we walk it recursively so:
	//   1) every nested subdirectory gets its own watch (Linux inotify has no
	//      native recursive mode — without this, a `mv` of an existing tree
	//      into the watched root would silently miss arbitrary descendants),
	//   2) image files already present (e.g. from a `mv` / `cp -r`) are
	//      counted as added so the debounced payload accurately summarizes
	//      the change.
	if ev.Op.Has(fsnotify.Create) {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			// Incremental add: root-failure is non-fatal (the parent dir's
			// watch is what gave us this Create event, so we already have
			// some visibility — we just lose the new subdir's nested
			// activity). anyChange stays true so the frontend re-Loads.
			_, added := addSubtree(w, ev.Name)
			acc.addedFiles += added
			acc.anyChange = true
			return true
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
			acc.anyChange = true
			return true
		}
		return false
	}

	triggered := false
	if ev.Op.Has(fsnotify.Create) {
		acc.addedFiles++
		triggered = true
	}
	if ev.Op.Has(fsnotify.Remove) {
		acc.removedFiles++
		triggered = true
	}
	if ev.Op.Has(fsnotify.Rename) {
		// Rename at the source path is observationally a Remove. The
		// destination, if inside a watched dir on the same fs, surfaces as
		// a separate Create event. We count the Rename as a Remove for
		// entries math, plus a renamedFiles tick for informational purposes.
		acc.removedFiles++
		acc.renamedFiles++
		triggered = true
	}
	// fsnotify.Write on an existing image leaves the entries set unchanged
	// (filename is still there). Phase 1 deliberately ignores it; the
	// frontend's useGridThumbnail cache is path-keyed so a content-only
	// edit would not refresh the displayed thumbnail anyway. Surfacing
	// content-edits is tracked for Phase 2 (would need a cache-invalidation
	// hook on the frontend). Spec §7.2 / §13.14.
	return triggered
}

// isHiddenName mirrors the rule in internal/classification/scanner.go to keep
// watched and scanned trees in sync. Dotfile / dotdir only — Windows-only
// hidden attribute is not consulted (deliberate v1 limit).
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}

// addSubtree adds root + every non-hidden descendant directory to w, and
// returns (rootAdded, imageCount): whether the root itself could be watched
// and how many image files were encountered in the walk. Used by both
//   - Start (initial enumeration; root failure is fatal, so the caller
//     checks rootAdded and bails out)
//   - the per-event handler when a directory is Created or moved into the
//     watched tree (the parent watch fired the Create, so root failure
//     here is non-fatal — we still want anyChange flagged)
//
// Failures on descendant Add calls are logged and skipped rather than
// aborting the walk — partial coverage beats none.
func addSubtree(w *fsnotify.Watcher, root string) (rootAdded bool, imageCount int) {
	// Add root explicitly first so callers can distinguish "root failed"
	// from "some descendant failed".
	if err := w.Add(root, fsnotify.All); err != nil {
		logging.Warn("watcher", "add root failed",
			"dir", root, "err", err.Error())
		return false, 0
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
		if imgfile.IsImage(d.Name()) {
			imageCount++
		}
		return nil
	})
	return true, imageCount
}
