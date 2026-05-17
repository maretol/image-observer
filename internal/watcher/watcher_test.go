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
