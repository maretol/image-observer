//go:build windows

package imgfile

import (
	"fmt"
	"syscall"
	"unsafe"
)

// SHFileOperationW 定数 (MSDN):
// https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationw
const (
	foDelete          = 0x0003
	fofAllowUndo      = 0x0040 // 削除でなく Recycle Bin へ送る
	fofNoConfirmation = 0x0010 // OS 確認ダイアログを抑制
	fofNoErrorUI      = 0x0400 // OS エラーダイアログを抑制
	fofSilent         = 0x0004 // 進捗 UI を抑制
	fofNoConfirmMkdir = 0x0200 // delete には不要だが害はない
)

// shFileOpStructW は C の SHFILEOPSTRUCTW に対応。フィールド順と padding を厳密に一致させる必要がある。
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

// Trash は absPath を SHFileOperationW で Windows ゴミ箱へ送る。
func Trash(absPath string) error {
	// pFrom は double-null 終端リスト。UTF16FromString の末尾 null に加えもう 1 つ要る。
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
