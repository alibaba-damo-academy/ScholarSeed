package handoff

import (
	"errors"
	"io"
	"os"
	"syscall"
)

func openRestartLog(filename string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	// Read-sharing permits feedback collection, while denying other writers and
	// deletion for this short restart phase. OPEN_ALWAYS never truncates.
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ, nil, syscall.OPEN_ALWAYS, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		syscall.CloseHandle(h)
		return nil, errors.New("unsafe native update log")
	}
	file := os.NewFile(uintptr(h), filename)
	if _, err = file.Seek(0, io.SeekEnd); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
