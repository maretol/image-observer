// Package imgfile provides shared image-file predicates used by other internal
// packages (tree listing, thumbnail generation, image reading, classification
// folder scanning). Keeping the predicate in one place avoids each consumer
// drifting on which extensions count as images.
package imgfile

import (
	"path/filepath"
	"strings"
)

var imageExts = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".gif":  true,
	".webp": true,
	".avif": true,
}

// IsImage reports whether the given filename has a supported image extension.
// Matching is case-insensitive.
func IsImage(name string) bool {
	return imageExts[strings.ToLower(filepath.Ext(name))]
}
