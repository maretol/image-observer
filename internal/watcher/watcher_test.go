package watcher

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
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
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 coalesced payload, got %d: %+v",
			len(got), got)
	}
	if got[0].AddedFiles != 5 {
		t.Errorf("AddedFiles: got %d, want 5", got[0].AddedFiles)
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
	m := NewManagerWithDebounce(func(ChangedPayload) {}, shortDebounce)
	if err := m.Start(filepath.Join(os.TempDir(), "does-not-exist-watcher-test")); err == nil {
		t.Errorf("Start on missing root should fail")
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

func sprintN(i int) string {
	const digits = "0123456789"
	if i < 10 {
		return string(digits[i])
	}
	return string(digits[i/10]) + string(digits[i%10])
}
