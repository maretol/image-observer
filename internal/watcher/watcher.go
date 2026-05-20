// Package watcher monitors a single folder (recursively) for file system
// changes that should refresh the classification ("list") tab UI. See
// docs/spec-folder-watch.md for the full design.
//
// The package wraps github.com/gofsnotify/fsnotify and adds:
//   - OS-agnostic recursive watching (Linux inotify and Windows
//     ReadDirectoryChangesW handled uniformly by enumerating subdirectories
//     ourselves and Add'ing each — Linux inotify has no native recursive mode)
//   - 200ms debounce + burst coalescing → a single emit() per quiet window
//   - filter (spec §7.2): emit on image-file Create/Remove/Rename, sidecar
//     events, dir Create (with recursive Add of descendants), and dir /
//     non-image Remove/Rename (treated as anyChange so the frontend re-Loads
//     when a subtree disappears). Image-file Write events do not emit on
//     their own — counters stay unchanged — but they DO extend the debounce
//     timer so a large image's Create→Write→Write… sequence keeps the quiet
//     window open until writes settle. Chmod-only and hidden paths are
//     silently ignored.
//
// The watcher is not responsible for re-loading classification entries; it
// only signals that "something inside the folder changed". The frontend
// reloads via LoadClassification on receipt of the emitted payload.
package watcher

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofsnotify/fsnotify"

	"image-observer/internal/logging"
)

// DefaultDebounce is the quiet-window length applied before a coalesced
// event is flushed to the emit callback. Picked to absorb camera bulk-copy
// bursts (~100 files/sec) while keeping UI feedback brisk. See spec §7.3.
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

	// watchedDirs tracks every directory we've successfully Add'd to the
	// fsnotify Watcher. Used to detect "this Remove/Rename event is for a
	// path we know was a directory" reliably, instead of relying on
	// w.Remove's return value (which is timing-dependent — Linux inotify
	// processes IN_IGNORED asynchronously, so by the time we hand-call
	// w.Remove on the IN_DELETE the watch may already be gone internally
	// and we'd get a misleading "not in watch list" error). Only written
	// by the loop goroutine (Create branch) and by Start (before the loop
	// starts); no concurrent access.
	watchedDirs map[string]struct{}

	// stopRequested is set true by stopLocked *before* closing the watcher.
	// The loop checks it on the Events-channel-closed path to decide
	// whether to flush pending events (explicit Stop = discard / treat the
	// close as user intent) versus log + flush (unexpected backend
	// failure). Read from a different goroutine, hence atomic.
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

	// Same-root + live goroutine: no-op. The existing watch was already
	// validated when it started, so we can skip the dir/symlink checks
	// for this branch. Done before any validation so a transient failure
	// to Lstat the same root (e.g. a temporary permission glitch) doesn't
	// tear down a working watch. Checking via the done channel keeps this
	// lock-free on the loop side.
	if m.state != nil && m.state.root == root && !goroutineExited(m.state) {
		return nil
	}

	// Intent has moved to a different root (or the existing state is a
	// zombie whose loop already exited). Tear down the old watch BEFORE
	// validating the new root — otherwise a validation failure on the new
	// root would leave the old watcher running while the JS-side intent
	// has already moved away, breaking the "current folder only"
	// invariant (JS treats the new root's Start failure as degraded mode
	// + manual reload; Go must not silently keep watching the old root).
	if m.state != nil {
		_ = m.stopLocked()
	}

	// Reject non-directory roots up front. inotify (and therefore
	// fsnotify.Watcher.Add) happily watches single files, so without this
	// check Start would succeed on a file path and then never deliver any
	// "image added in folder" events — appearing healthy but doing nothing.
	//
	// Lstat (not Stat) so a symlink-to-dir root is rejected too: the
	// subsequent filepath.WalkDir(root, ...) lstats the root itself and
	// would see a symlink (not a dir), skipping descent and leaving
	// nested subdirectory watches unset. The classification scanner
	// (internal/classification/scanner.go) has the same Lstat-at-root
	// constraint, so admitting symlink roots in the watcher without
	// aligning the scanner would emit events for nested changes the
	// scanner can never surface.
	info, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("watcher: lstat root %q: %w", root, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("watcher: root must not be a symlink, got %q", root)
	}
	if !info.IsDir() {
		return fmt.Errorf("watcher: root must be a directory, got %q (mode %s)",
			root, info.Mode().Type())
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("watcher: NewWatcher: %w", err)
	}

	// watchedDirs is populated by addSubtree during the initial walk and
	// extended by the loop's Create branch.
	watchedDirs := make(map[string]struct{})

	// Root must succeed: without it we can't see top-level changes (image
	// add/remove directly in `root`). Descendants are best-effort. The
	// initial walk uses the collect-free overload — at Start time no
	// inotify Create events are queued for discovered images, so there is
	// nothing to dedup against.
	if !addSubtree(w, root, watchedDirs) {
		_ = w.Close()
		return fmt.Errorf("watcher: cannot watch root %q", root)
	}

	st := &watchState{
		watcher:     w,
		root:        root,
		stop:        make(chan struct{}),
		done:        make(chan struct{}),
		watchedDirs: watchedDirs,
	}
	m.state = st
	go m.loop(st)
	logging.Info("watcher", "started", "folder", root)
	return nil
}

// goroutineExited reports whether the loop for st has already returned.
// Used by Start to detect zombie states (loop ended via a backend-channel
// close without a paired Stop) so we don't no-op into a non-functional
// watch.
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

// Current returns the root of the last-built watcher state, or "" when no
// state exists (= Stop'd, or never Started). A non-empty return does NOT
// guarantee the loop goroutine is still running — root vanish or a backend
// close leaves `m.state` as a "zombie" with `goroutineExited(st) == true`
// until the next Stop or Start tears it down. Callers that need "is
// monitoring actually live for this folder?" should ALSO check that the
// next Start would no-op (i.e., not consult Current alone). Used by tests
// / debug callers; production code tracks the intended folder
// independently via folderRef on the JS side instead of polling this.
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

	// Capture errCh locally so we can set it to nil when fsnotify closes
	// the Errors channel — otherwise the closed channel stays
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
				//   - explicit Stop → discard pending (a trailing flush
				//     after StopFolderWatch returned would emit
				//     "classification:changed" the user no longer wants)
				//   - unexpected backend close (fsnotify died,
				//     max_watches overflow, etc.) → log + flush whatever
				//     we accumulated so the user at least gets the
				//     partial result; spec §10.2
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
			if classifyAndAccumulate(&pending, ev, st) {
				resetTimer()
			}
			// Root vanished: a Remove / Rename on the watched root itself
			// (e.g. the user deleted or moved the folder out from under
			// us) leaves Linux inotify's watch dangling via IN_IGNORED;
			// we'd keep this goroutine alive forever waiting on a dead
			// fd, and since Manager.Start short-circuits on same-root +
			// live goroutine, the next openFolder of the same path would
			// also no-op. Flush whatever was pending so the frontend at
			// least re-Loads (and surfaces the absence), then tear down
			// the fsnotify resources before exiting — leaving the Watcher
			// open until the next explicit Stop/Start would leak its fd
			// and reader goroutine for the entire window the user spends
			// in the now-orphaned folder. stopLocked() detects
			// `stopRequested` to remain idempotent if the user happens to
			// call Stop concurrently while the loop is already on its way
			// out.
			if (ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename)) && ev.Name == st.root {
				if timer != nil {
					timer.Stop()
				}
				// Stop concurrency: if an explicit Stop landed before we
				// got here, honour the "discard pending" contract — the
				// user already asked monitoring off and a trailing
				// "watch root vanished" warn + flush after
				// StopFolderWatch returned would be doubly misleading
				// (no callback wanted, and root vanish is a noisy state
				// for a folder we no longer care about). Mirrors the
				// timer / Events !ok / st.stop branches that all skip
				// the trailing flush on stopRequested.
				if st.stopRequested.Load() {
					return
				}
				logging.Warn("watcher", "watch root vanished",
					"folder", st.root, "op", ev.Op.String())
				pending.anyChange = true
				flush()
				// Mark stopRequested so the !ok branch above (which
				// fires once st.watcher.Close drains the Events channel)
				// treats the close as intentional and skips its log +
				// flush duplication. The actual goroutine termination is
				// via the `return` below — Close just releases
				// fsnotify's internal goroutine / fd.
				st.stopRequested.Store(true)
				_ = st.watcher.Close()
				return
			}
		case err, ok := <-errCh:
			if !ok {
				// fsnotify closed Errors. Don't return (Events may still
				// be live); disable this case to avoid spinning.
				errCh = nil
				continue
			}
			logging.Warn("watcher", "channel error", "err", err.Error())
			// We can't reliably distinguish a benign warning from a
			// lost-event indicator (e.g. inotify IN_Q_OVERFLOW would
			// arrive here in some fsnotify forks). Be safe and flag
			// anyChange so the next flush prompts the frontend to
			// re-Load — without this, a queue overflow silently leaves
			// the listing stale even though we know our event stream is
			// incomplete.
			pending.anyChange = true
			resetTimer()
		case <-timerCh:
			timerCh = nil
			// Stop and the debounce timer can both become ready in the
			// same select tick. Go picks a ready case at random, so even
			// after stopLocked has set stopRequested + closed st.stop,
			// this branch can still win and flush pending events —
			// violating the "explicit Stop discards pending" contract
			// enforced by the Events !ok and st.stop branches above.
			if st.stopRequested.Load() {
				return
			}
			flush()
		case <-st.stop:
			if timer != nil {
				timer.Stop()
			}
			// Same rationale as the Events !ok branch above — explicit
			// Stop drops pending events. We arrive here when the stop
			// signal wins the select before watcher.Close drains the
			// Events channel.
			return
		}
	}
}
