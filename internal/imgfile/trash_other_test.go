//go:build !windows

package imgfile

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTrashFallback exercises the non-windows fallback (os.Remove). The
// Windows SHFileOperationW path is untested in CI because the CI runner is
// Linux; it is verified manually on a Windows build (see PR test plan).
func TestTrashFallback(t *testing.T) {
	dir := t.TempDir()

	t.Run("removes existing file", func(t *testing.T) {
		p := filepath.Join(dir, "victim.png")
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatalf("setup write: %v", err)
		}
		if err := Trash(p); err != nil {
			t.Fatalf("Trash returned error: %v", err)
		}
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("file still exists after Trash; stat err = %v", err)
		}
	})

	t.Run("error on missing file", func(t *testing.T) {
		p := filepath.Join(dir, "does-not-exist.png")
		if err := Trash(p); err == nil {
			t.Fatal("expected error for missing file, got nil")
		}
	})

	t.Run("error on read-only parent dir", func(t *testing.T) {
		// Create a parent dir with no write permission and a victim file inside.
		// os.Remove on the victim requires write+execute on the parent.
		parent := filepath.Join(dir, "ro")
		if err := os.Mkdir(parent, 0o755); err != nil {
			t.Fatalf("mkdir parent: %v", err)
		}
		victim := filepath.Join(parent, "v.png")
		if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
			t.Fatalf("setup write: %v", err)
		}
		if err := os.Chmod(parent, 0o500); err != nil {
			t.Fatalf("chmod parent: %v", err)
		}
		// Restore perms in cleanup so t.TempDir's RemoveAll can succeed.
		t.Cleanup(func() { _ = os.Chmod(parent, 0o755) })

		// Root bypasses unix permission checks; skip when CI happens to run as root.
		if os.Geteuid() == 0 {
			t.Skip("running as root; permission check would not fail")
		}

		if err := Trash(victim); err == nil {
			t.Fatal("expected permission error, got nil")
		}
	})
}
