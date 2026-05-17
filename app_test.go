package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDeleteImage_PathValidation covers the input-validation portion of
// DeleteImage. On non-Windows builds Trash falls back to os.Remove, so a
// successful call also removes the file — which lets us exercise both the
// happy path (validation passes, file disappears) and the reject paths
// (validation fails, no filesystem mutation) from one suite.
//
// The Windows SHFileOperationW path is untested in CI (Linux runner); the
// validation logic itself is OS-independent so this suite gives us
// confidence on the part of DeleteImage that does run on every push.
func TestDeleteImage_PathValidation(t *testing.T) {
	app := &App{}

	t.Run("rejects empty folderPath", func(t *testing.T) {
		if err := app.DeleteImage("", "foo.png"); err == nil {
			t.Fatal("expected error for empty folderPath")
		}
	})

	t.Run("rejects empty filename", func(t *testing.T) {
		if err := app.DeleteImage(t.TempDir(), ""); err == nil {
			t.Fatal("expected error for empty filename")
		}
	})

	t.Run("rejects relative folderPath", func(t *testing.T) {
		if err := app.DeleteImage("relative/folder", "foo.png"); err == nil {
			t.Fatal("expected error for relative folderPath")
		}
	})

	t.Run("rejects absolute filename", func(t *testing.T) {
		// On unix an absolute path filename starts with "/". The
		// validation also rejects Windows drive-letter abs paths through
		// filepath.IsAbs's OS-specific semantics.
		err := app.DeleteImage(t.TempDir(), "/etc/passwd")
		if err == nil {
			t.Fatal("expected error for absolute filename")
		}
		if !strings.Contains(err.Error(), "relative") &&
			!strings.Contains(err.Error(), "escape") {
			t.Fatalf("unexpected error message: %v", err)
		}
	})

	t.Run("rejects parent-escape via ..", func(t *testing.T) {
		err := app.DeleteImage(t.TempDir(), "../escape.png")
		if err == nil {
			t.Fatal("expected error for parent-escape filename")
		}
		if !strings.Contains(err.Error(), "escape") {
			t.Fatalf("unexpected error message: %v", err)
		}
	})

	t.Run("rejects parent-escape via nested ..", func(t *testing.T) {
		// "sub/../../escape.png" cleans to "../escape.png" relative to
		// folder; filepath.Rel sees it leaves the folder and reports
		// a leading "..".
		err := app.DeleteImage(t.TempDir(), "sub/../../escape.png")
		if err == nil {
			t.Fatal("expected error for nested escape filename")
		}
	})

	t.Run("accepts innocent .. inside basename", func(t *testing.T) {
		// The old `strings.Contains(name, "..")` check rejected this
		// false-positive. The new filepath.Rel-based check accepts it.
		dir := t.TempDir()
		victim := filepath.Join(dir, "v1..final.png")
		if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
			t.Fatalf("setup write: %v", err)
		}
		if err := app.DeleteImage(dir, "v1..final.png"); err != nil {
			t.Fatalf("expected delete to succeed, got: %v", err)
		}
		if _, err := os.Stat(victim); !os.IsNotExist(err) {
			t.Fatalf("file still exists; stat err = %v", err)
		}
	})

	t.Run("accepts subdirectory filename", func(t *testing.T) {
		dir := t.TempDir()
		sub := filepath.Join(dir, "sub")
		if err := os.Mkdir(sub, 0o755); err != nil {
			t.Fatalf("mkdir sub: %v", err)
		}
		victim := filepath.Join(sub, "foo.png")
		if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
			t.Fatalf("setup write: %v", err)
		}
		if err := app.DeleteImage(dir, "sub/foo.png"); err != nil {
			t.Fatalf("expected delete to succeed, got: %v", err)
		}
		if _, err := os.Stat(victim); !os.IsNotExist(err) {
			t.Fatalf("file still exists; stat err = %v", err)
		}
	})

	t.Run("trims whitespace", func(t *testing.T) {
		dir := t.TempDir()
		victim := filepath.Join(dir, "trim.png")
		if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
			t.Fatalf("setup write: %v", err)
		}
		if err := app.DeleteImage("  "+dir+"  ", "  trim.png  "); err != nil {
			t.Fatalf("expected delete to succeed after trim, got: %v", err)
		}
		if _, err := os.Stat(victim); !os.IsNotExist(err) {
			t.Fatalf("file still exists; stat err = %v", err)
		}
	})
}

// TestStartFolderWatch_PathValidation exercises the input-validation
// portion of StartFolderWatch (empty / relative rejection) plus the
// happy-path delegation to watcher.Manager. The Manager itself is
// covered by internal/watcher tests; this suite makes sure the app-layer
// wrapper doesn't silently regress its validation contract or its wiring
// to a.watch (which NewApp constructs eagerly so bindings always have a
// non-nil receiver — see app.go NewApp).
//
// PR #75 review 19th: app_test.go previously had no coverage for this
// binding, so a regression in the wrapper would only surface at runtime.
func TestStartFolderWatch_PathValidation(t *testing.T) {
	app := NewApp()
	t.Cleanup(func() { _ = app.StopFolderWatch() })

	t.Run("rejects empty folderPath", func(t *testing.T) {
		if err := app.StartFolderWatch(""); err == nil {
			t.Fatal("expected error for empty folderPath")
		}
	})

	t.Run("rejects whitespace-only folderPath", func(t *testing.T) {
		// TrimSpace runs before the empty check, so "   " collapses to "".
		if err := app.StartFolderWatch("   "); err == nil {
			t.Fatal("expected error for whitespace-only folderPath")
		}
	})

	t.Run("rejects relative folderPath", func(t *testing.T) {
		err := app.StartFolderWatch("relative/folder")
		if err == nil {
			t.Fatal("expected error for relative folderPath")
		}
		if !strings.Contains(err.Error(), "absolute") {
			t.Fatalf("error message should mention 'absolute', got: %v", err)
		}
	})

	t.Run("accepts absolute existing directory (happy path)", func(t *testing.T) {
		dir := t.TempDir()
		if err := app.StartFolderWatch(dir); err != nil {
			t.Fatalf("expected Start to succeed on tempdir, got: %v", err)
		}
		// Stop is the documented way to release the inotify FD; the
		// t.Cleanup above also calls it, but doing it here keeps the
		// "no leaked watch between subtests" property explicit.
		if err := app.StopFolderWatch(); err != nil {
			t.Fatalf("Stop after happy-path Start should succeed, got: %v", err)
		}
	})

	t.Run("Stop is idempotent when nothing is watched", func(t *testing.T) {
		// After the previous subtest's Stop, no watch is active. A second
		// Stop must not error — the docstring on StopFolderWatch promises
		// idempotency.
		if err := app.StopFolderWatch(); err != nil {
			t.Fatalf("second Stop should be idempotent, got: %v", err)
		}
	})
}
