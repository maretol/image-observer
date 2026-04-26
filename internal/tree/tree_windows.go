//go:build windows

package tree

import (
	"os"
	"strings"
	"syscall"
)

func isHidden(fullPath string, entry os.DirEntry) (bool, error) {
	if strings.HasPrefix(entry.Name(), ".") {
		return true, nil
	}
	pointer, err := syscall.UTF16PtrFromString(fullPath)
	if err != nil {
		return false, err
	}
	attrs, err := syscall.GetFileAttributes(pointer)
	if err != nil {
		return false, err
	}
	return attrs&syscall.FILE_ATTRIBUTE_HIDDEN != 0, nil
}
