package classification

import (
	"fmt"
	"os"

	"image-observer/internal/imgfile"
)

// FileScanner enumerates the image filenames directly under a folder.
// Subfolders are not traversed.
type FileScanner interface {
	ListImageFiles(folderPath string) ([]string, error)
}

// NewFileScanner returns the default scanner backed by os.ReadDir.
func NewFileScanner() FileScanner {
	return fsScanner{}
}

type fsScanner struct{}

func (fsScanner) ListImageFiles(folderPath string) ([]string, error) {
	entries, err := os.ReadDir(folderPath)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !imgfile.IsImage(name) {
			continue
		}
		out = append(out, name)
	}
	return out, nil
}
