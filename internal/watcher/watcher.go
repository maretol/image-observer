// Package watcher monitors a single folder (recursively) for file system
// changes that should refresh the classification ("list") tab UI. See
// docs/spec-folder-watch.md for the full design.
//
// The package wraps github.com/gofsnotify/fsnotify and adds:
//   - OS-agnostic recursive watching (Linux inotify and Windows ReadDirectoryChangesW
//     handled uniformly by enumerating subdirectories ourselves and Add'ing each)
//   - 200ms debounce + burst coalescing → a single emit() per quiet window
//   - filter for image files, sidecar JSON, and directory creation; everything
//     else is silently ignored
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

// Start begins watching root. If a watch is already active on a different
// root it is stopped first; calling Start on the currently-watched root is a
// no-op. Returns an error if no directory under root could be watched at all
// (callers degrade to manual reload in that case — see spec §5.5).
func (m *Manager) Start(root string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state != nil {
		if m.state.root == root {
			return nil
		}
		_ = m.stopLocked()
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("watcher: NewWatcher: %w", err)
	}

	addCount := 0
	walkErr := filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			// Skip unreadable subtrees but keep walking siblings.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != root && isHiddenName(d.Name()) {
			return fs.SkipDir
		}
		if err := w.Add(p, fsnotify.All); err != nil {
			// inotify max_user_watches exhaustion, perm denied, etc.
			// Logged for diagnostics; carry on so the rest still watches.
			logging.Warn("watcher", "add dir failed",
				"dir", p, "err", err.Error())
			return nil
		}
		addCount++
		return nil
	})
	if walkErr != nil {
		_ = w.Close()
		return fmt.Errorf("watcher: walk %q: %w", root, walkErr)
	}
	if addCount == 0 {
		_ = w.Close()
		return fmt.Errorf("watcher: no directory could be watched under %q", root)
	}

	st := &watchState{
		watcher: w,
		root:    root,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	m.state = st
	go m.loop(st)
	logging.Info("watcher", "started",
		"folder", root, "watchCount", addCount)
	return nil
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
	// Signal the loop to drain & exit first, then close the watcher (which
	// also breaks out of any in-flight read). Both pathways converge on the
	// loop's defer close(done).
	close(st.stop)
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
				flush()
				return
			}
			logging.Debug("watcher", "event",
				"op", ev.Op.String(), "path", ev.Name)
			if classifyAndAccumulate(&pending, ev, st.watcher) {
				resetTimer()
			}
		case err, ok := <-st.watcher.Errors:
			if !ok {
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
			flush()
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
	// On a confirmed dir we add a watch incrementally so files dropped inside
	// later still register. We do NOT pre-walk the new dir's contents — any
	// files dropped between Create and Add will be picked up by the
	// frontend's re-Load (which uses classification.scanner / WalkDir).
	if ev.Op.Has(fsnotify.Create) {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			if addErr := w.Add(ev.Name, fsnotify.All); addErr != nil {
				logging.Warn("watcher", "add dir failed (incremental)",
					"dir", ev.Name, "err", addErr.Error())
			}
			acc.anyChange = true
			return true
		}
	}

	// Below here we only care about image files. Non-image files (e.g.
	// `.txt`, `_classification.csv`, `.bak`) generate no UI-visible change.
	if !imgfile.IsImage(base) {
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
	// fsnotify.Write on an existing image doesn't change entries; thumbs
	// re-key off mtime/size automatically. Spec §7.2.
	return triggered
}

// isHiddenName mirrors the rule in internal/classification/scanner.go to keep
// watched and scanned trees in sync. Dotfile / dotdir only — Windows-only
// hidden attribute is not consulted (deliberate v1 limit).
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}
