package watcher

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gofsnotify/fsnotify"
)

// These tests rely on the host's real fsnotify backend (inotify on Linux,
// ReadDirectoryChangesW on Windows). CI runs on ubuntu-latest so the Linux
// path is covered; the Windows path is exercised by manual / packaged
// builds.

// shortDebounce keeps test runtime tight while still leaving inotify a
// little headroom over its raw notification latency.
const shortDebounce = 30 * time.Millisecond

type captured struct {
	mu       sync.Mutex
	payloads []ChangedPayload
}

func newCaptured() *captured { return &captured{} }

func (c *captured) emit(p ChangedPayload) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.payloads = append(c.payloads, p)
}

// waitForPayload polls c until at least n payloads are seen (or t times out).
// Returns the slice of payloads accumulated so far so the caller can assert
// on either the count alone (n) or merged contents (when bursts coalesce).
func (c *captured) waitForPayload(t *testing.T, n int, timeout time.Duration) []ChangedPayload {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		got := len(c.payloads)
		c.mu.Unlock()
		if got >= n {
			c.mu.Lock()
			out := append([]ChangedPayload(nil), c.payloads...)
			c.mu.Unlock()
			return out
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	t.Fatalf("timeout waiting for %d payload(s) (got %d): %+v",
		n, len(c.payloads), c.payloads)
	return nil
}

// reset clears already-captured payloads so the caller can assert on a
// subsequent action's emit count without the earlier burst confounding it.
func (c *captured) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.payloads = nil
}

// expectNoPayload waits the given window and asserts emit was never called.
// Used to verify chmod / non-image / hidden events are filtered out.
func (c *captured) expectNoPayload(t *testing.T, window time.Duration) {
	t.Helper()
	time.Sleep(window)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.payloads) > 0 {
		t.Fatalf("expected no payload, got %d: %+v",
			len(c.payloads), c.payloads)
	}
}

func writeImage(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("fake-image-bytes"), 0o644); err != nil {
		t.Fatalf("write %q: %v", path, err)
	}
}

// newClassifyTestState builds a minimal *watchState wrapping the provided
// fsnotify watcher so unit tests for classifyAndAccumulate can call it
// without spinning up a full Manager. PR #75 14th: signature change from
// (*fsnotify.Watcher) to (*watchState) so the Remove branch can consult
// watchedDirs reliably.
func newClassifyTestState(w *fsnotify.Watcher) *watchState {
	return &watchState{
		watcher:     w,
		watchedDirs: make(map[string]struct{}),
	}
}

func TestStart_NewImage_Emits(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	writeImage(t, filepath.Join(dir, "a.png"))

	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].AddedFiles != 1 {
		t.Errorf("AddedFiles: got %d, want 1 (payloads=%+v)", got[0].AddedFiles, got)
	}
	if got[0].Folder != dir {
		t.Errorf("Folder: got %q, want %q", got[0].Folder, dir)
	}
}

func TestStart_BurstCoalescedIntoOnePayload(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	for i := range 5 {
		writeImage(t, filepath.Join(dir, sprintN(i)+".jpg"))
	}

	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].AddedFiles != 5 {
		t.Errorf("AddedFiles: got %d, want 5", got[0].AddedFiles)
	}

	// waitForPayload returns as soon as 1 payload arrives, which doesn't
	// prove coalescing held. Wait one more full debounce window with no
	// further writes and verify no extra payloads were emitted.
	time.Sleep(shortDebounce * 4)
	cap.mu.Lock()
	totalAfter := len(cap.payloads)
	cap.mu.Unlock()
	if totalAfter != 1 {
		t.Fatalf("expected exactly 1 coalesced payload, got %d", totalAfter)
	}
}

func TestStart_NonImageIgnored(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	cap.expectNoPayload(t, shortDebounce*4)
}

func TestStart_HiddenDirIgnored(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".cache"), 0o755); err != nil {
		t.Fatalf("mkdir hidden: %v", err)
	}
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	// Even direct writes to a hidden dir at the root should be skipped
	// because we never Add it to the watcher (and even if a stray event
	// leaked through, the basename `.foo` is hidden).
	writeImage(t, filepath.Join(dir, ".cache", "ghost.png"))

	cap.expectNoPayload(t, shortDebounce*4)
}

func TestStart_SubdirCreatedThenFileInside(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	sub := filepath.Join(dir, "child")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Wait for the burst from the dir creation to flush so we don't conflate
	// it with the file-inside event.
	cap.waitForPayload(t, 1, time.Second)

	// File dropped into the new subdir; verify the incremental Add picked
	// it up.
	writeImage(t, filepath.Join(sub, "inside.png"))
	got := cap.waitForPayload(t, 2, time.Second)
	if got[1].AddedFiles != 1 {
		t.Errorf("second payload AddedFiles: got %d, want 1 (all=%+v)",
			got[1].AddedFiles, got)
	}
}

func TestStart_SidecarWriteFlagsSidecarChanged(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	sidecar := filepath.Join(dir, "_classification.json")
	if err := os.WriteFile(sidecar, []byte(`{"version":1,"entries":[]}`), 0o644); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}

	got := cap.waitForPayload(t, 1, time.Second)
	if !got[0].SidecarChanged {
		t.Errorf("SidecarChanged: got false, want true (payloads=%+v)", got)
	}
	if got[0].AddedFiles != 0 {
		t.Errorf("AddedFiles should be 0 for sidecar-only change, got %d", got[0].AddedFiles)
	}
}

func TestStop_HaltsFurtherEmits(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}

	if err := m.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if cur := m.Current(); cur != "" {
		t.Errorf("Current after Stop: got %q, want \"\"", cur)
	}

	writeImage(t, filepath.Join(dir, "after-stop.png"))
	cap.expectNoPayload(t, shortDebounce*4)
}

func TestStart_SwitchingRootsDropsOldEvents(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(a); err != nil {
		t.Fatalf("Start a: %v", err)
	}
	if err := m.Start(b); err != nil {
		t.Fatalf("Start b: %v", err)
	}
	defer m.Stop()
	if cur := m.Current(); cur != b {
		t.Errorf("Current: got %q, want %q", cur, b)
	}

	// Writes into the abandoned watch must not surface.
	writeImage(t, filepath.Join(a, "stale.png"))
	cap.expectNoPayload(t, shortDebounce*4)

	// Writes into the live watch must.
	writeImage(t, filepath.Join(b, "live.png"))
	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].Folder != b {
		t.Errorf("Folder: got %q, want %q", got[0].Folder, b)
	}
	if got[0].AddedFiles != 1 {
		t.Errorf("AddedFiles: got %d, want 1", got[0].AddedFiles)
	}
}

func TestStart_SameRootTwiceIsNoOp(t *testing.T) {
	dir := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()
	if err := m.Start(dir); err != nil {
		t.Errorf("Start same root again should be no-op, got %v", err)
	}
	if cur := m.Current(); cur != dir {
		t.Errorf("Current: got %q, want %q", cur, dir)
	}
}

func TestStart_FailsOnMissingRoot(t *testing.T) {
	// Compose the missing path inside a fresh t.TempDir so the test cannot
	// be defeated by a stale leftover directory from a prior run in
	// the OS-wide temp area (PR #75 review).
	m := NewManagerWithDebounce(func(ChangedPayload) {}, shortDebounce)
	missing := filepath.Join(t.TempDir(), "definitely-missing")
	if err := m.Start(missing); err == nil {
		t.Errorf("Start on missing root should fail")
	}
}

func TestStart_ImageRemoveBumpsRemovedFiles(t *testing.T) {
	// PR #75 review: image Remove / Rename were the headline Phase 1
	// behaviors but had no integration coverage.
	dir := t.TempDir()
	img := filepath.Join(dir, "victim.png")
	writeImage(t, img)

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	if err := os.Remove(img); err != nil {
		t.Fatalf("rm: %v", err)
	}
	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].RemovedFiles != 1 {
		t.Errorf("RemovedFiles: got %d, want 1 (payloads=%+v)",
			got[0].RemovedFiles, got)
	}
	if got[0].AddedFiles != 0 {
		t.Errorf("AddedFiles should be 0, got %d", got[0].AddedFiles)
	}
}

func TestStart_ImageRenameBumpsRenamedAndAdded(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "before.png")
	dst := filepath.Join(dir, "after.png")
	writeImage(t, src)

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	if err := os.Rename(src, dst); err != nil {
		t.Fatalf("rename: %v", err)
	}
	got := cap.waitForPayload(t, 1, time.Second)
	// Rename within the same watched dir surfaces as Rename (source) +
	// Create (dest). classifyAndAccumulate counts the source's Remove
	// portion AND the renamedFiles tick on the Rename op, then the dest
	// path's Create bumps AddedFiles. Net: +1 added, +1 removed, +1 renamed.
	if got[0].RenamedFiles != 1 {
		t.Errorf("RenamedFiles: got %d, want 1 (payloads=%+v)",
			got[0].RenamedFiles, got)
	}
	if got[0].AddedFiles != 1 {
		t.Errorf("AddedFiles: got %d, want 1", got[0].AddedFiles)
	}
	if got[0].RemovedFiles != 1 {
		t.Errorf("RemovedFiles: got %d, want 1", got[0].RemovedFiles)
	}
}

// TestClassificationChangedEventName pins the literal value so a Go-side
// rename without a paired TS-side rename trips CI. The frontend ships a
// matching assertion in features/classification/watcherPolicy.test.ts.
// AGENTS.md D-1 (cross-language constant drift detection).
func TestClassificationChangedEventName(t *testing.T) {
	if ClassificationChangedEvent != "classification:changed" {
		t.Errorf("event name drifted: got %q, want %q",
			ClassificationChangedEvent, "classification:changed")
	}
}

func TestStop_DiscardsPendingBurst(t *testing.T) {
	// PR #75 review: an explicit Stop in the middle of a debounce window
	// must NOT flush. Otherwise switching watchMode = "off" or closing the
	// app surfaces a stale "classification:changed" the user just opted
	// out of.
	dir := t.TempDir()
	cap := newCaptured()
	// Use a long debounce so we can Stop while the timer is still pending.
	m := NewManagerWithDebounce(cap.emit, 1*time.Second)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}

	writeImage(t, filepath.Join(dir, "in-flight.png"))
	// Give inotify a beat to deliver the Create + classifyAndAccumulate to
	// land it in `pending` (but well within the 1s debounce).
	time.Sleep(80 * time.Millisecond)

	if err := m.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	// If Stop flushed, a payload would already be queued (no further wait
	// needed); confirm it stayed silent.
	cap.expectNoPayload(t, 200*time.Millisecond)
}

func TestStart_MoveInExistingTreePicksUpNested(t *testing.T) {
	// PR #75 review: Linux inotify only signals the top-level Create when an
	// existing subtree is moved into the watched root. We need to walk and
	// Add nested subdirs on the spot — and count pre-existing image files —
	// or activity inside them later goes unobserved.
	root := t.TempDir()
	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	// Build the source tree outside the watched root, then atomically rename
	// into the root to simulate a `mv existing-dir watched/`.
	staging := t.TempDir()
	srcTop := filepath.Join(staging, "moved")
	srcNested := filepath.Join(srcTop, "nested")
	if err := os.MkdirAll(srcNested, 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}
	writeImage(t, filepath.Join(srcTop, "top.png"))
	writeImage(t, filepath.Join(srcNested, "deep.png"))

	dst := filepath.Join(root, "moved")
	if err := os.Rename(srcTop, dst); err != nil {
		t.Fatalf("rename: %v", err)
	}

	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].AddedFiles != 2 {
		t.Errorf("AddedFiles for mv-in tree: got %d, want 2 (payloads=%+v)",
			got[0].AddedFiles, got)
	}

	// Now confirm the nested watch was actually registered: drop a file
	// into the nested subdir and we should see it.
	writeImage(t, filepath.Join(dst, "nested", "after-move.png"))
	got = cap.waitForPayload(t, 2, time.Second)
	if got[1].AddedFiles != 1 {
		t.Errorf("AddedFiles for post-move nested write: got %d, want 1 (all=%+v)",
			got[1].AddedFiles, got)
	}
}

func TestStart_RemovedSubdirFlagsAnyChange(t *testing.T) {
	// PR #75 review: removing a non-image, non-sidecar path (typically a
	// subdirectory) must still trigger a flush so the frontend re-Loads. The
	// previous classifier dropped it on the `!imgfile.IsImage(base)` floor
	// and the UI was left showing stale entries.
	root := t.TempDir()
	sub := filepath.Join(root, "doomed")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	// Remove the empty subdir; we should still get at least one payload
	// even though no image / sidecar event was involved.
	if err := os.Remove(sub); err != nil {
		t.Fatalf("rmdir: %v", err)
	}
	got := cap.waitForPayload(t, 1, time.Second)
	// addedFiles / removedFiles stay 0 — we only flag anyChange because we
	// can't tell from the event alone whether the path was image-bearing.
	if got[0].AddedFiles != 0 || got[0].RemovedFiles != 0 {
		t.Errorf("dir-only remove should not bump counters, got %+v", got[0])
	}
}

func TestStart_SymlinkToExternalDirNotFollowed(t *testing.T) {
	// PR #75 review 7th, thread A: a symlink created inside the watched
	// folder pointing to an external directory must NOT pull that target
	// into the watch tree. addSubtree on the symlink would follow it,
	// surfacing events from paths the user never picked and breaking the
	// "current folder only" precondition. We expect a generic anyChange
	// (so the listing refreshes) but no nested watch on the target.
	root := t.TempDir()
	external := t.TempDir() // separate tempdir; intentionally outside `root`

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	// Create the symlink. This Create event hits the dir-Create branch via
	// Lstat → ModeSymlink detection.
	// On Windows, os.Symlink requires Developer Mode or
	// SeCreateSymbolicLinkPrivilege; without those it returns a permission
	// error. Skip rather than fail in that case so `go test ./...` from a
	// stock Windows developer machine doesn't error out (PR #75 8th, thread D).
	linkPath := filepath.Join(root, "link-to-external")
	if err := os.Symlink(external, linkPath); err != nil {
		t.Skipf("symlink unavailable in this environment: %v", err)
	}
	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].AddedFiles != 0 {
		t.Errorf("symlink Create should not count files in target, got %+v", got[0])
	}

	// Drain any further payloads from the symlink Create itself.
	cap.reset()

	// Now write an image into the external dir. If addSubtree had followed
	// the link we'd see an addedFiles=1 payload here; with the Lstat skip
	// we expect no further payload (the watch on the target was never
	// installed).
	writeImage(t, filepath.Join(external, "would-not-show.png"))
	cap.expectNoPayload(t, shortDebounce*4)
}

func TestStart_RootVanishedAllowsRestart(t *testing.T) {
	// PR #75 9th, thread F: when the watched root itself is removed /
	// renamed, the inotify watch goes dangling (Linux IN_IGNORED). The
	// loop must detect this and exit so that
	//   1) `goroutineExited(st)` returns true on the next Start,
	//   2) Manager.Start's same-root short-circuit doesn't no-op into
	//      a dead watch when the user recreates the folder and reopens.
	parent := t.TempDir()
	root := filepath.Join(parent, "vanishes")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	if err := os.Remove(root); err != nil {
		t.Fatalf("rm root: %v", err)
	}
	// The loop should flush an anyChange payload and exit. Wait for the
	// payload first.
	_ = cap.waitForPayload(t, 1, time.Second)

	// Poll for the goroutine actually being gone (defer close(st.done)).
	// Looking at m.Current() indirectly — if the loop exited, Current()
	// still returns root until Stop / Start, but Start can detect zombie
	// via goroutineExited. We check the recovery path by recreating root
	// and Start-ing again: this should rebuild rather than no-op.
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatalf("mkdir recreated root: %v", err)
	}
	cap.reset()
	if err := m.Start(root); err != nil {
		t.Fatalf("Start after root vanished: %v", err)
	}
	// Verify the rebuilt watch is live by writing an image and waiting
	// for the resulting payload.
	writeImage(t, filepath.Join(root, "after-recovery.png"))
	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].AddedFiles != 1 {
		t.Errorf("rebuilt watch should see new image, got %+v", got[0])
	}
}

func TestStart_ImageExtensionSymlinkCountedAsAddedFile(t *testing.T) {
	// PR #75 review 8th, thread E: classification.scanner.go includes any
	// path with an image extension in entries regardless of symlink status
	// (it uses Lstat-derived DirEntry and checks extension only). For the
	// emitted payload's addedFiles count to match what the next re-Load
	// surfaces, an image-extension symlink Create must bump addedFiles, not
	// just flag generic anyChange. Same Windows symlink-permission caveat
	// as above — skip rather than fail when symlink is unavailable.
	root := t.TempDir()
	external := t.TempDir()
	target := filepath.Join(external, "real.png")
	writeImage(t, target)

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	linkPath := filepath.Join(root, "image-link.png")
	if err := os.Symlink(target, linkPath); err != nil {
		t.Skipf("symlink unavailable in this environment: %v", err)
	}
	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].AddedFiles != 1 {
		t.Errorf("image-extension symlink should bump addedFiles, got %+v", got[0])
	}
}

func TestStart_ChmodOnly_NotEmitted(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "x.png")
	writeImage(t, img)

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(dir); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	if err := os.Chmod(img, 0o600); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	cap.expectNoPayload(t, shortDebounce*4)
}

// classifyAndAccumulate-level unit test for the dir-Create / image-Create
// dedup (PR #75 5th-round review). When addSubtree's WalkDir already counted
// an image file, a subsequent inotify Create for the same path must NOT
// double-count it.
func TestClassify_DirCreateThenSamePathImageCreate_NoDoubleCount(t *testing.T) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	defer w.Close()

	acc := &changedAccumulator{}
	// Simulate: addSubtree found an image at /staged/photo.png and parked
	// the path for dedup. The accumulator state we craft here matches what
	// the dir-Create branch would produce after WalkDir.
	acc.addedFiles = 1
	acc.anyChange = true
	acc.discoveredImagePaths = map[string]struct{}{
		"/staged/photo.png": {},
	}

	// Now the concurrent inotify Create arrives for the same path. Without
	// dedup we'd hit addedFiles=2; with dedup we stay at 1 and consume the
	// parked entry.
	ev := fsnotify.Event{Name: "/staged/photo.png", Op: fsnotify.Create}
	if !classifyAndAccumulate(acc, ev, newClassifyTestState(w)) {
		t.Errorf("Create should still trigger debounce reset even when deduped")
	}
	if acc.addedFiles != 1 {
		t.Errorf("dedup failed: addedFiles got %d, want 1", acc.addedFiles)
	}
	if _, still := acc.discoveredImagePaths["/staged/photo.png"]; still {
		t.Errorf("dedup entry should be consumed (one-shot)")
	}

	// A second Create for the same path *now* (post-consume) counts as a
	// genuine new addition.
	if !classifyAndAccumulate(acc, ev, newClassifyTestState(w)) {
		t.Errorf("second Create should trigger")
	}
	if acc.addedFiles != 2 {
		t.Errorf("post-consume re-Create: addedFiles got %d, want 2", acc.addedFiles)
	}
}

// TestStart_SubdirRenameOutUnwatchesDescendants verifies that renaming a
// subdirectory out of the watched tree unwatches not just the subdirectory
// itself but also all of its descendant directories. Linux inotify tracks
// watches by inode (not path), so after a rename the descendant watches
// stay alive and continue to deliver events labelled with the OLD path —
// violating the "current folder only" invariant unless we explicitly
// w.Remove every descendant (PR #75 15th, threads B/C).
func TestStart_SubdirRenameOutUnwatchesDescendants(t *testing.T) {
	root := t.TempDir()
	external := t.TempDir()
	parent := filepath.Join(root, "parent")
	child := filepath.Join(parent, "child")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("mkdir tree: %v", err)
	}

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	// Move parent out of the watched root.
	dst := filepath.Join(external, "moved-parent")
	if err := os.Rename(parent, dst); err != nil {
		t.Fatalf("rename out: %v", err)
	}
	// Wait for the rename event(s) to flush.
	_ = cap.waitForPayload(t, 1, time.Second)
	cap.reset()

	// Write an image into the moved-out child. If the descendant watch
	// was properly cleaned up, no event surfaces. If it leaked, the
	// payload would include AddedFiles=1 for an external path.
	writeImage(t, filepath.Join(dst, "child", "leaked.png"))
	cap.expectNoPayload(t, shortDebounce*4)
}

// TestStart_ImageExtensionDirRemovedAsAnyChange verifies that removing a
// directory whose name happens to carry an image extension (e.g.
// `photos.jpg/`) does NOT bump removedFiles. PR #75 14th, thread D: the
// classification scanner ignores directories entirely, so reporting "image
// removed" for a removed dir over-counts. We detect the dir-vs-file
// distinction via `watchState.watchedDirs` (a per-Manager set populated by
// addSubtree*). The earlier draft used w.Remove's return value but that
// is timing-dependent — Linux inotify processes IN_IGNORED asynchronously
// and may have already evicted the watch internally by the time the
// IN_DELETE event reaches our hand-call, so the return value falsely
// reports "not in watch list" and the path falls through to the image
// branch. The shared dir-set avoids that race entirely.
func TestStart_ImageExtensionDirRemovedAsAnyChange(t *testing.T) {
	root := t.TempDir()
	dirPath := filepath.Join(root, "looks-like-image.png")
	if err := os.Mkdir(dirPath, 0o755); err != nil {
		t.Fatalf("mkdir image-named dir: %v", err)
	}

	cap := newCaptured()
	m := NewManagerWithDebounce(cap.emit, shortDebounce)
	if err := m.Start(root); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer m.Stop()

	if err := os.Remove(dirPath); err != nil {
		t.Fatalf("rmdir: %v", err)
	}
	got := cap.waitForPayload(t, 1, time.Second)
	if got[0].RemovedFiles != 0 {
		t.Errorf("image-extension dir removal should not bump removedFiles, got %+v", got[0])
	}
	if got[0].RenamedFiles != 0 {
		t.Errorf("image-extension dir removal should not bump renamedFiles, got %+v", got[0])
	}
	// anyChange (= the payload was emitted at all) is enough for the
	// frontend to re-Load; the inverse "would payload have been emitted
	// without anyChange?" is asserted by waitForPayload succeeding.
}

// TestClassify_DirCreateSharesDiscoveredDedup verifies that two dir-Create
// events whose walks discover overlapping image paths don't double-count.
// PR #75 12th round, thread B: when a parent dir Create's WalkDir already
// found image X.png inside a (then-also-created) child dir, a subsequent
// child-dir Create event must consult acc.discoveredImagePaths and skip
// the duplicate count.
func TestClassify_DirCreateSharesDiscoveredDedup(t *testing.T) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	defer w.Close()

	// Build: root/parent/child/photo.png on disk
	root := t.TempDir()
	parent := filepath.Join(root, "parent")
	child := filepath.Join(parent, "child")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatalf("mkdir tree: %v", err)
	}
	writeImage(t, filepath.Join(child, "photo.png"))

	// 1st event: dir Create for parent. addSubtreeCollect walks the
	// whole tree under parent, finds child/photo.png, returns it.
	// addedFiles bumps to 1 and parks the path.
	acc := &changedAccumulator{}
	st := newClassifyTestState(w)
	parentEv := fsnotify.Event{Name: parent, Op: fsnotify.Create}
	if !classifyAndAccumulate(acc, parentEv, st) {
		t.Fatalf("parent Create should trigger")
	}
	if acc.addedFiles != 1 {
		t.Errorf("after parent walk: addedFiles got %d, want 1", acc.addedFiles)
	}

	// 2nd event: dir Create for child (the race scenario — fsnotify
	// fires both parent and child events). addSubtreeCollect walks
	// child, finds the same photo.png. Without dedup we'd bump
	// addedFiles to 2; with the new shared dedup it stays at 1.
	childEv := fsnotify.Event{Name: child, Op: fsnotify.Create}
	if !classifyAndAccumulate(acc, childEv, st) {
		t.Fatalf("child Create should still trigger debounce reset")
	}
	if acc.addedFiles != 1 {
		t.Errorf("dir-Create shared dedup failed: addedFiles got %d, want 1 (double-count regression)", acc.addedFiles)
	}
}

// classifyAndAccumulate-level unit test for the Write-extends-debounce
// behavior (PR #75 4th-round review). Write on an existing image must:
//   - return true so the loop resets the debounce timer (= keep the quiet
//     window open while a large image is still being copied),
//   - leave all counters at 0 and anyChange = false so the trailing flush
//     does not emit a spurious empty payload.
//
// Integration timing tests are too flaky for the inotify Write cadence to
// rely on; we hold the classifier honest here and let
// TestStart_BurstCoalescedIntoOnePayload cover the broader scenario.
func TestClassify_WriteOnImageTriggersTimerWithoutBumpingCounters(t *testing.T) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	defer w.Close()

	acc := &changedAccumulator{}
	ev := fsnotify.Event{Name: "/anywhere/photo.png", Op: fsnotify.Write}
	if !classifyAndAccumulate(acc, ev, newClassifyTestState(w)) {
		t.Errorf("Write on an image should return true to extend debounce")
	}
	if acc.addedFiles != 0 || acc.removedFiles != 0 ||
		acc.renamedFiles != 0 || acc.sidecarChanged || acc.anyChange {
		t.Errorf("Write should not bump counters / anyChange, got %+v", acc)
	}
}

func sprintN(i int) string {
	const digits = "0123456789"
	if i < 10 {
		return string(digits[i])
	}
	return string(digits[i/10]) + string(digits[i%10])
}
