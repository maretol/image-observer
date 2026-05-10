package classification

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"image-observer/internal/imgfile"
)

// FileScanner enumerates the image files under a folder. As of Phase 4 v1.2 the
// scanner walks subdirectories recursively and returns paths relative to the
// scanned root using POSIX separators ("/"), e.g. "a.jpg" or "child1/x.png".
//
// Symlinks are NOT followed (filepath.WalkDir uses Lstat-style entries), which
// avoids the need for inode tracking and loop detection. Hidden directories
// (names starting with ".") are skipped wholesale.
type FileScanner interface {
	ListImageFiles(folderPath string) ([]string, error)
}

// NewFileScanner returns the default scanner backed by filepath.WalkDir.
func NewFileScanner() FileScanner {
	return fsScanner{}
}

type fsScanner struct{}

func (fsScanner) ListImageFiles(folderPath string) ([]string, error) {
	// Surface a clean error when the root itself is missing or unreadable;
	// downstream WalkDir errors at this entry are otherwise swallowed by the
	// "best-effort" branch below.
	if _, err := os.Stat(folderPath); err != nil {
		return nil, fmt.Errorf("stat root: %w", err)
	}
	var out []string
	err := filepath.WalkDir(folderPath, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Best-effort: skip this entry but keep walking siblings.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path == folderPath {
			return nil // root itself
		}
		name := d.Name()
		if isHiddenName(name) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !imgfile.IsImage(name) {
			return nil
		}
		rel, err := filepath.Rel(folderPath, path)
		if err != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk dir: %w", err)
	}
	sort.Strings(out)
	return out, nil
}

// isHiddenName treats names starting with "." as hidden. Windows-only Hidden
// attribute is not supported here; we accept that as a pragmatic limit since
// image folders rarely depend on it. Sidecar files (_classification.*) start
// with "_" rather than "." so they are excluded by the imgfile.IsImage filter
// instead, not this function.
func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".")
}
