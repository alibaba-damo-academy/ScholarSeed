//go:build !windows

package handoff

import (
	"errors"
	"io"
	"os"
	"syscall"
)

// The handoff is Windows-only; this counterpart exercises diagnostic contracts
// on the development host without following symlinks or changing user state.
func openRestartLog(filename string) (*os.File, error) {
	fd, err := syscall.Open(filename, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), filename)
	var info syscall.Stat_t
	if err = syscall.Fstat(fd, &info); err != nil || info.Nlink != 1 || info.Mode&syscall.S_IFMT != syscall.S_IFREG {
		file.Close()
		return nil, errors.New("unsafe native update log")
	}
	if _, err = file.Seek(0, io.SeekEnd); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
