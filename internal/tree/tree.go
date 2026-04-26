package tree

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Node struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Mtime int64  `json:"mtime"`
	Size  int64  `json:"size"`
}

var imageExts = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".gif":  true,
	".webp": true,
}

// IsImage reports whether the given filename has a supported image extension.
// Used by tree listing and by other packages (thumb, imgread) for input checks.
func IsImage(name string) bool {
	return imageExts[strings.ToLower(filepath.Ext(name))]
}

// isCyclicPath reports whether `abs` resolves (via symlinks) to one of its own ancestors.
// When true, listing this directory would recurse into itself.
func isCyclicPath(abs string) bool {
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil || resolved == "" || resolved == abs {
		return false
	}
	cur := filepath.Dir(abs)
	for {
		if cur == resolved {
			return true
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return false
		}
		cur = parent
	}
}

// List returns immediate children (one level only) of the given path.
// See spec-folder-tree.md §3.2 for behavior.
func List(path string) ([]Node, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}

	if isCyclicPath(abs) {
		return []Node{}, nil
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		// Tag the error with a prefix the frontend can match on.
		// See spec-error-handling.md §3.1.
		switch {
		case errors.Is(err, fs.ErrPermission):
			return nil, fmt.Errorf("PERM: %w", err)
		case errors.Is(err, fs.ErrNotExist):
			return nil, fmt.Errorf("NOENT: %w", err)
		default:
			return nil, err
		}
	}

	out := make([]Node, 0, len(entries))
	for _, entry := range entries {
		full := filepath.Join(abs, entry.Name())

		hidden, err := isHidden(full, entry)
		if err != nil {
			log.Printf("isHidden failed for %q: %v", full, err)
			continue
		}
		if hidden {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			log.Printf("Info failed for %q: %v", full, err)
			continue
		}

		if info.Mode()&os.ModeSymlink != 0 {
			target, err := filepath.EvalSymlinks(full)
			if err != nil {
				log.Printf("EvalSymlinks failed for %q: %v", full, err)
				continue
			}
			tinfo, err := os.Stat(target)
			if err != nil {
				log.Printf("Stat (symlink target) failed for %q -> %q: %v", full, target, err)
				continue
			}
			info = tinfo
		}

		switch {
		case info.IsDir():
			out = append(out, Node{
				Path:  full,
				Name:  entry.Name(),
				Kind:  "dir",
				Mtime: info.ModTime().Unix(),
				Size:  0,
			})
		case IsImage(entry.Name()):
			out = append(out, Node{
				Path:  full,
				Name:  entry.Name(),
				Kind:  "image",
				Mtime: info.ModTime().Unix(),
				Size:  info.Size(),
			})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}
