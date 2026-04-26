package tree

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestIsImage(t *testing.T) {
	cases := map[string]bool{
		"a.jpg":     true,
		"a.JPG":     true,
		"a.jpeg":    true,
		"a.png":     true,
		"a.gif":     true,
		"a.WebP":    true,
		"a.bmp":     false,
		"a.txt":     false,
		"noext":     false,
		".hidden":   false,
		".hidden.j": false,
	}
	for name, want := range cases {
		if got := IsImage(name); got != want {
			t.Errorf("IsImage(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestListDirectory_FilterAndSort(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "Zebra.jpg"))
	mustWrite(t, filepath.Join(dir, "alpha.PNG"))
	mustWrite(t, filepath.Join(dir, "ignored.txt"))
	mustWrite(t, filepath.Join(dir, ".hidden.jpg"))
	mustMkdir(t, filepath.Join(dir, "sub_b"))
	mustMkdir(t, filepath.Join(dir, "Sub_a"))
	mustMkdir(t, filepath.Join(dir, ".hiddendir"))

	nodes, err := List(dir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	gotNames := make([]string, len(nodes))
	gotKinds := make([]string, len(nodes))
	for i, n := range nodes {
		gotNames[i] = n.Name
		gotKinds[i] = n.Kind
	}

	wantNames := []string{"alpha.PNG", "Sub_a", "sub_b", "Zebra.jpg"}
	wantKinds := []string{"image", "dir", "dir", "image"}

	if !equal(gotNames, wantNames) {
		t.Errorf("names mismatch:\n  got  %v\n  want %v", gotNames, wantNames)
	}
	if !equal(gotKinds, wantKinds) {
		t.Errorf("kinds mismatch:\n  got  %v\n  want %v", gotKinds, wantKinds)
	}
}

func TestListDirectory_EmptyDir(t *testing.T) {
	dir := t.TempDir()
	nodes, err := List(dir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(nodes) != 0 {
		t.Errorf("expected 0 nodes for empty dir, got %d", len(nodes))
	}
}

func TestListDirectory_AbsolutePath(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "x.jpg"))
	nodes, err := List(dir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(nodes) != 1 {
		t.Fatalf("expected 1 node, got %d", len(nodes))
	}
	if !filepath.IsAbs(nodes[0].Path) {
		t.Errorf("Path should be absolute, got %q", nodes[0].Path)
	}
}

func TestListDirectory_SymlinkLoop(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need elevation on Windows")
	}
	dir := t.TempDir()
	loop := filepath.Join(dir, "loop")
	if err := os.Symlink(dir, loop); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	// First listing: symlink resolves to dir itself, so it appears as a "dir" node.
	nodes, err := List(dir)
	if err != nil {
		t.Fatalf("List(dir): %v", err)
	}
	if len(nodes) != 1 || nodes[0].Name != "loop" || nodes[0].Kind != "dir" {
		t.Fatalf("expected one dir node 'loop', got %+v", nodes)
	}

	// Listing the loop must NOT recurse infinitely; it should return [].
	nodes, err = List(loop)
	if err != nil {
		t.Fatalf("List(loop): %v", err)
	}
	if len(nodes) != 0 {
		t.Errorf("expected empty for cyclic symlink, got %+v", nodes)
	}
}

func TestListDirectory_SymlinkToImage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need elevation on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "real.png")
	mustWrite(t, target)
	link := filepath.Join(dir, "link.png")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	nodes, err := List(dir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	imageCount := 0
	for _, n := range nodes {
		if n.Kind == "image" {
			imageCount++
		}
	}
	if imageCount != 2 {
		t.Errorf("expected 2 image nodes (real + link), got %d (%+v)", imageCount, nodes)
	}
}

func TestListDirectory_NotExist(t *testing.T) {
	_, err := List(filepath.Join(t.TempDir(), "does-not-exist"))
	if err == nil {
		t.Error("expected error for non-existent path")
	}
}

func mustWrite(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile %q: %v", path, err)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatalf("Mkdir %q: %v", path, err)
	}
}

func equal(a, b []string) bool {
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
