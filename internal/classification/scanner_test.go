package classification

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestScanner_FiltersByExtension(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		"a.jpg", "b.PNG", "c.gif", "d.WebP", "e.txt", "f.bmp", "ignore.go",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got, err := NewFileScanner().ListImageFiles(dir)
	if err != nil {
		t.Fatalf("ListImageFiles: %v", err)
	}
	sort.Strings(got)
	want := []string{"a.jpg", "b.PNG", "c.gif", "d.WebP"}
	sort.Strings(want)
	if !equalSlice(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestScanner_NonexistentFolder(t *testing.T) {
	_, err := NewFileScanner().ListImageFiles(filepath.Join(t.TempDir(), "nope"))
	if err == nil {
		t.Errorf("expected error for missing folder")
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
