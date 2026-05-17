package classification

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nowPlusOneSec() time.Time {
	return time.Now().Add(1 * time.Second)
}

func TestRepository_LoadNone(t *testing.T) {
	dir := t.TempDir()
	out, err := NewFileRepository().Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out.Source != "none" || out.Data != nil || out.Mtime != 0 {
		t.Errorf("expected empty result, got %+v", out)
	}
}

func TestRepository_RoundTripJSON(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{
		Version: SchemaVersion,
		Entries: []Entry{
			{Filename: "a.jpg", Folder: "iroha", Confidence: ConfHigh, Note: "n1"},
			{Filename: "b.png", Folder: "shugo (a + b)", Confidence: ConfMid, Note: "n2"},
		},
	}
	mtime, err := repo.SaveJSON(dir, c, 0)
	if err != nil {
		t.Fatalf("SaveJSON: %v", err)
	}
	if mtime <= 0 {
		t.Errorf("expected positive mtime, got %d", mtime)
	}

	out, err := repo.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out.Source != "json" {
		t.Errorf("Source = %q, want json", out.Source)
	}
	if out.Mtime != mtime {
		t.Errorf("Mtime = %d, want %d", out.Mtime, mtime)
	}
	if len(out.Data.Entries) != 2 || out.Data.Entries[0].Folder != "iroha" {
		t.Errorf("entries lost in round trip: %+v", out.Data.Entries)
	}
}

func TestRepository_BackupCreated(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{Version: SchemaVersion, Entries: []Entry{{Filename: "a.jpg"}}}
	if _, err := repo.SaveJSON(dir, c, 0); err != nil {
		t.Fatalf("first save: %v", err)
	}
	// Second save: .bak should appear.
	mtime1, _ := repo.SaveJSON(dir, c, 0)
	_ = mtime1
	if _, err := os.Stat(filepath.Join(dir, BackupJSON)); err != nil {
		t.Errorf("expected .bak to exist: %v", err)
	}
	// .tmp must not linger after a successful save.
	if _, err := os.Stat(filepath.Join(dir, TempJSON)); err == nil {
		t.Errorf(".tmp should not exist after a successful save")
	}
}

func TestRepository_ConflictDetection(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{Version: SchemaVersion, Entries: []Entry{{Filename: "a.jpg"}}}
	mtime, err := repo.SaveJSON(dir, c, 0)
	if err != nil {
		t.Fatalf("first save: %v", err)
	}

	// Simulate external modification: write the file with a newer mtime.
	jsonPath := filepath.Join(dir, SidecarJSON)
	if err := os.WriteFile(jsonPath, []byte(`{"version":1,"entries":[]}`), 0o644); err != nil {
		t.Fatalf("external write: %v", err)
	}
	// Bump mtime explicitly in case the FS coalesces sub-nanosecond updates.
	future := nowPlusOneSec()
	if err := os.Chtimes(jsonPath, future, future); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}

	// Saving with the stale mtime must fail with ErrConflict.
	if _, err := repo.SaveJSON(dir, c, mtime); !errors.Is(err, ErrConflict) {
		t.Errorf("want ErrConflict, got %v", err)
	}

	// And the externally written file must still be on disk untouched.
	contents, _ := os.ReadFile(jsonPath)
	if !strings.Contains(string(contents), `"entries":[]`) {
		t.Errorf("conflict path must not modify the file, got %q", string(contents))
	}
}

// TestRepository_DeletedFileTreatedAsConflict verifies the docstring's
// "If the file went away entirely, treat that as a conflict too" promise:
// when expectedMtime > 0 (the caller observed the file at Load) and the
// sidecar has been deleted before Save runs, the Save must return
// ErrConflict instead of silently re-creating the file. Without this, an
// edit-mid-delete sequence (user editing while an external tool removes
// the sidecar) would silently overwrite whatever caused the delete.
// PR #75 16th, thread E.
func TestRepository_DeletedFileTreatedAsConflict(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{Version: SchemaVersion, Entries: []Entry{{Filename: "a.jpg"}}}
	mtime, err := repo.SaveJSON(dir, c, 0)
	if err != nil {
		t.Fatalf("first save: %v", err)
	}

	// Simulate external deletion of the sidecar between Load and Save.
	if err := os.Remove(filepath.Join(dir, SidecarJSON)); err != nil {
		t.Fatalf("external delete: %v", err)
	}

	// Saving with the (now-stale) mtime must fail with ErrConflict, not
	// silently re-create the file.
	if _, err := repo.SaveJSON(dir, c, mtime); !errors.Is(err, ErrConflict) {
		t.Errorf("delete-mid-edit save should be ErrConflict, got %v", err)
	}

	// And the file must still not exist (no silent re-create).
	if _, err := os.Stat(filepath.Join(dir, SidecarJSON)); !os.IsNotExist(err) {
		t.Errorf("conflict path must not re-create the file, got stat err = %v", err)
	}
}

// TestRepository_DirReplacedTreatedAsConflict verifies that when the sidecar
// path has been replaced by a directory between Load and Save, the conflict
// check returns ErrConflict instead of leaving the failure to the subsequent
// copyFile / WriteFile / Rename steps (which would surface an opaque IO
// error far from the actual cause). Mtime may even match by coincidence
// when a dir replaces the file, so the equality check below isn't enough on
// its own — the IsDir branch is added to the existing nil-err arm so the
// frontend's standard conflict dialog can surface the user choice the same
// way the file-gone case does. PR #75 25th, thread B.
func TestRepository_DirReplacedTreatedAsConflict(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{Version: SchemaVersion, Entries: []Entry{{Filename: "a.jpg"}}}
	mtime, err := repo.SaveJSON(dir, c, 0)
	if err != nil {
		t.Fatalf("first save: %v", err)
	}

	// Simulate the file being replaced by a directory while the caller still
	// holds the original mtime. We remove the file first to release the
	// inode, then mkdir at the same path. The directory's mtime will most
	// likely differ but we don't want to depend on that — the IsDir check
	// catches the case even if the mtime happens to coincide.
	jsonPath := filepath.Join(dir, SidecarJSON)
	if err := os.Remove(jsonPath); err != nil {
		t.Fatalf("remove file: %v", err)
	}
	if err := os.Mkdir(jsonPath, 0o755); err != nil {
		t.Fatalf("mkdir at sidecar path: %v", err)
	}

	if _, err := repo.SaveJSON(dir, c, mtime); !errors.Is(err, ErrConflict) {
		t.Errorf("dir-replaced save should be ErrConflict, got %v", err)
	}

	// The directory must still be intact — the conflict path must not have
	// rmdir'd or otherwise mutated it.
	if info, err := os.Stat(jsonPath); err != nil || !info.IsDir() {
		t.Errorf("conflict path must not mutate the replacement dir, got info=%+v err=%v", info, err)
	}
}

func TestRepository_ForceOverwrite(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{Version: SchemaVersion, Entries: []Entry{{Filename: "a.jpg"}}}
	if _, err := repo.SaveJSON(dir, c, 0); err != nil {
		t.Fatalf("first save: %v", err)
	}
	// expectedMtime=0 forces overwrite even if the file changed.
	if err := os.WriteFile(filepath.Join(dir, SidecarJSON), []byte(`{"version":1}`), 0o644); err != nil {
		t.Fatalf("external write: %v", err)
	}
	if _, err := repo.SaveJSON(dir, c, 0); err != nil {
		t.Errorf("force overwrite should succeed, got %v", err)
	}
}

func TestRepository_CreateJSONExisting(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	c := &Classification{Version: SchemaVersion, Entries: []Entry{}}
	if _, err := repo.CreateJSON(dir, c); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if _, err := repo.CreateJSON(dir, c); !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("want ErrAlreadyExists, got %v", err)
	}
}

func TestRepository_LoadCSV(t *testing.T) {
	dir := t.TempDir()
	csv := "filename,proposed_folder,confidence,note\n" +
		"a.jpg,iroha,high,first\n" +
		"\"b.png\",\"shugo (a + b)\",mid,\"contains, comma\"\n"
	if err := os.WriteFile(filepath.Join(dir, SidecarCSV), []byte(csv), 0o644); err != nil {
		t.Fatalf("write csv: %v", err)
	}
	out, err := NewFileRepository().Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out.Source != "csv" || out.Mtime != 0 {
		t.Errorf("Source=%q Mtime=%d, want csv/0", out.Source, out.Mtime)
	}
	if len(out.Data.Entries) != 2 {
		t.Fatalf("entries=%d, want 2", len(out.Data.Entries))
	}
	if got := out.Data.Entries[1].Folder; got != "shugo (a + b)" {
		t.Errorf("entries[1].Folder = %q", got)
	}
	if got := out.Data.Entries[1].Note; got != "contains, comma" {
		t.Errorf("entries[1].Note = %q (commas in quoted CSV must survive)", got)
	}
}

func TestRepository_LoadCSV_BOM(t *testing.T) {
	dir := t.TempDir()
	csv := "\xEF\xBB\xBFfilename,proposed_folder,confidence,note\n" +
		"a.jpg,iroha,high,n\n"
	if err := os.WriteFile(filepath.Join(dir, SidecarCSV), []byte(csv), 0o644); err != nil {
		t.Fatalf("write csv: %v", err)
	}
	out, err := NewFileRepository().Load(dir)
	if err != nil {
		t.Fatalf("Load with BOM: %v", err)
	}
	if len(out.Data.Entries) != 1 || out.Data.Entries[0].Filename != "a.jpg" {
		t.Errorf("BOM stripping failed: %+v", out.Data.Entries)
	}
}

func TestRepository_LoadCSV_HeaderOrderShuffled(t *testing.T) {
	dir := t.TempDir()
	csv := "note,confidence,filename,proposed_folder\n" +
		"n,high,a.jpg,iroha\n"
	if err := os.WriteFile(filepath.Join(dir, SidecarCSV), []byte(csv), 0o644); err != nil {
		t.Fatalf("write csv: %v", err)
	}
	out, err := NewFileRepository().Load(dir)
	if err != nil {
		t.Fatalf("Load shuffled header: %v", err)
	}
	got := out.Data.Entries[0]
	if got.Filename != "a.jpg" || got.Folder != "iroha" || got.Confidence != "high" || got.Note != "n" {
		t.Errorf("shuffled header parsed wrong: %+v", got)
	}
}

func TestRepository_DuplicateFilenameRejected(t *testing.T) {
	dir := t.TempDir()
	csv := "filename,proposed_folder,confidence,note\n" +
		"a.jpg,t1,,\n" +
		"a.jpg,t2,,\n"
	if err := os.WriteFile(filepath.Join(dir, SidecarCSV), []byte(csv), 0o644); err != nil {
		t.Fatalf("write csv: %v", err)
	}
	if _, err := NewFileRepository().Load(dir); !errors.Is(err, ErrDuplicate) {
		t.Errorf("want ErrDuplicate, got %v", err)
	}
}

func TestRepository_JSONPreferredOverCSV(t *testing.T) {
	dir := t.TempDir()
	repo := NewFileRepository()
	if _, err := repo.SaveJSON(dir, &Classification{
		Version: SchemaVersion,
		Entries: []Entry{{Filename: "from-json.jpg"}},
	}, 0); err != nil {
		t.Fatalf("save json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, SidecarCSV),
		[]byte("filename,proposed_folder,confidence,note\nfrom-csv.jpg,,,\n"), 0o644); err != nil {
		t.Fatalf("write csv: %v", err)
	}
	out, err := repo.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if out.Source != "json" || out.Data.Entries[0].Filename != "from-json.jpg" {
		t.Errorf("expected JSON to win, got %+v", out)
	}
}
