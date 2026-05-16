//go:build windows

package imgfile

import (
	"fmt"
	"syscall"
	"unsafe"
)

// SHFileOperationW constants. See MSDN:
// https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationw
const (
	foDelete          = 0x0003
	fofAllowUndo      = 0x0040 // send to Recycle Bin instead of deleting
	fofNoConfirmation = 0x0010 // suppress OS confirm dialog
	fofNoErrorUI      = 0x0400 // suppress OS error dialog
	fofSilent         = 0x0004 // suppress progress UI
	fofNoConfirmMkdir = 0x0200 // not strictly needed for delete; harmless
)

// shFileOpStructW mirrors the SHFILEOPSTRUCTW C struct. Field order and
// padding must match exactly for the syscall to read it correctly.
type shFileOpStructW struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

var (
	modShell32           = syscall.NewLazyDLL("shell32.dll")
	procSHFileOperationW = modShell32.NewProc("SHFileOperationW")
)

// Trash sends `absPath` to the Windows Recycle Bin via SHFileOperationW.
// Returns nil on success, or an error describing the SHFileOperationW return
// code on failure (typical reasons: file not found, permission denied,
// destination drive does not support the Recycle Bin — e.g. some network
// shares or removable media).
func Trash(absPath string) error {
	// SHFileOperationW's pFrom is a *double*-null-terminated string list.
	// For one path we still need the trailing extra null, so we append a
	// zero to the UTF16 slice produced by UTF16FromString (which already
	// terminates with one null).
	utf16, err := syscall.UTF16FromString(absPath)
	if err != nil {
		return fmt.Errorf("trash: utf16 conversion: %w", err)
	}
	utf16 = append(utf16, 0)

	op := shFileOpStructW{
		wFunc:  foDelete,
		pFrom:  &utf16[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofNoErrorUI | fofSilent | fofNoConfirmMkdir,
	}

	ret, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if ret != 0 {
		return fmt.Errorf("trash: SHFileOperationW returned 0x%x", ret)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("trash: operation aborted by shell")
	}
	return nil
}
