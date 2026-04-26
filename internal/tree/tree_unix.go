//go:build !windows

package tree

import (
	"os"
	"strings"
)

func isHidden(_ string, entry os.DirEntry) (bool, error) {
	return strings.HasPrefix(entry.Name(), "."), nil
}
