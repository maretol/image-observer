package classification

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestScanner_FlatFiltersByExtension(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		"a.jpg", "b.PNG", "c.gif", "d.WebP", "e.txt", "f.bmp", "ignore.go",
	} {
		writeFile(t, filepath.Join(dir, name))
	}
	got, _, err := NewFileScanner().ListImageFiles(dir)
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	want := []string{"a.jpg", "b.PNG", "c.gif", "d.WebP"}
	sort.Strings(got)
	sort.Strings(want)
	if !equalSlice(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestScanner_RecurseIntoSubdirs(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.jpg"))
	writeFile(t, filepath.Join(dir, "child1", "hoge.png"))
	writeFile(t, filepath.Join(dir, "child2", "fuga.gif"))
	writeFile(t, filepath.Join(dir, "child2", "deep", "x.webp"))
	writeFile(t, filepath.Join(dir, "child2", "deep", "ignore.txt"))

	got, _, err := NewFileScanner().ListImageFiles(dir)
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	want := []string{
		"a.jpg",
		"child1/hoge.png",
		"child2/deep/x.webp",
		"child2/fuga.gif",
	}
	if !equalSlice(got, want) {
		t.Errorf("got %v, want %v (POSIX separators, sorted)", got, want)
	}
}

func TestScanner_SkipsHiddenDirsAndFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "visible.jpg"))
	writeFile(t, filepath.Join(dir, ".hidden.png"))
	writeFile(t, filepath.Join(dir, ".hiddenDir", "inside.jpg"))

	got, _, err := NewFileScanner().ListImageFiles(dir)
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	want := []string{"visible.jpg"}
	if !equalSlice(got, want) {
		t.Errorf("got %v, want %v (hidden entries excluded)", got, want)
	}
}

func TestScanner_SidecarFilesIgnored(t *testing.T) {
	// imgfile.IsImage filters by extension, so sidecar files are naturally
	// excluded. This test pins that contract so changes to IsImage cannot
	// silently start picking up sidecars.
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.jpg"))
	writeFile(t, filepath.Join(dir, SidecarJSON))
	writeFile(t, filepath.Join(dir, SidecarCSV))
	writeFile(t, filepath.Join(dir, BackupJSON))
	writeFile(t, filepath.Join(dir, TempJSON))

	got, _, err := NewFileScanner().ListImageFiles(dir)
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	if !equalSlice(got, []string{"a.jpg"}) {
		t.Errorf("got %v, want only [a.jpg]", got)
	}
}

func TestScanner_NonexistentFolder(t *testing.T) {
	_, _, err := NewFileScanner().ListImageFiles(filepath.Join(t.TempDir(), "nope"))
	if err == nil {
		t.Errorf("expected error for missing folder")
	}
}

func TestScanner_EmptyFolder(t *testing.T) {
	got, _, err := NewFileScanner().ListImageFiles(t.TempDir())
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty slice, got %v", got)
	}
}

// #144: walk 中に各画像の mtime (Unix 秒) を収集する。非画像 / hidden は名前と同様に対象外。
func TestScanner_CollectsFileTimes(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.jpg"))
	writeFile(t, filepath.Join(dir, "child", "b.png"))
	writeFile(t, filepath.Join(dir, "note.txt"))
	aTime := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	bTime := time.Date(2026, 6, 7, 8, 9, 10, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(dir, "a.jpg"), aTime, aTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(dir, "child", "b.png"), bTime, bTime); err != nil {
		t.Fatal(err)
	}

	names, times, err := NewFileScanner().ListImageFiles(dir)
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	if !equalSlice(names, []string{"a.jpg", "child/b.png"}) {
		t.Fatalf("names = %v", names)
	}
	if got, want := times["a.jpg"], aTime.Unix(); got != want {
		t.Errorf("times[a.jpg] = %d, want %d", got, want)
	}
	if got, want := times["child/b.png"], bTime.Unix(); got != want {
		t.Errorf("times[child/b.png] = %d, want %d", got, want)
	}
	if len(times) != 2 {
		t.Errorf("times size = %d, want 2 (%v)", len(times), times)
	}
}
