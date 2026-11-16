package main

import (
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// A missing endpoint denotes an old client. Other failures cannot silently fall
// back: a client may already be saving state or refusing shutdown.
func requestInstallationExit(root string) (bool, error) {
	canonical, err := canonicalDirectory(root)
	if err != nil {
		return false, err
	}
	handle, err := syscall.CreateFile(utf(setupPipe(canonical)), syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, 0, 0)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	defer syscall.CloseHandle(handle)
	var pid uint32
	ok, _, err := kernel.NewProc("GetNamedPipeServerProcessId").Call(uintptr(handle), uintptr(unsafe.Pointer(&pid)))
	if ok == 0 {
		return true, err
	}
	image, err := setupProcessImage(pid, 0)
	if err != nil {
		return true, err
	}
	directory, err := canonicalDirectory(filepath.Dir(image))
	if err != nil {
		return true, err
	}
	if !strings.HasPrefix(strings.ToLower(directory), strings.ToLower(canonical)+`\`) {
		return true, errors.New("installation shutdown endpoint belongs to another application")
	}
	var written uint32
	if err := syscall.WriteFile(handle, []byte("prepare\n"), &written, nil); err != nil {
		return true, err
	}
	if written != uint32(len("prepare\n")) {
		return true, errors.New("incomplete installation shutdown request")
	}
	deadline := time.Now().Add(setupExitTimeout)
	var response []byte
	for time.Now().Before(deadline) {
		var available uint32
		ok, _, err := kernel.NewProc("PeekNamedPipe").Call(uintptr(handle), 0, 0, 0, uintptr(unsafe.Pointer(&available)), 0)
		if ok == 0 {
			return true, err
		}
		if available > 0 {
			var buffer [setupFrameBytes]byte
			var read uint32
			if err := syscall.ReadFile(handle, buffer[:], &read, nil); err != nil {
				return true, err
			}
			response = append(response, buffer[:read]...)
			switch string(response) {
			case "ready\n":
				var acknowledged uint32
				err := syscall.WriteFile(handle, []byte("commit\n"), &acknowledged, nil)
				if err != nil {
					return true, err
				}
				if acknowledged != uint32(len("commit\n")) {
					return true, errors.New("incomplete installation exit acknowledgement")
				}
				return true, nil
			case "cancelled\n":
				return true, errSetupCancelled
			case "failed\n", "busy\n":
				return true, errSetupBusy
			}
			if len(response) >= len(buffer) || strings.ContainsRune(string(response), '\n') {
				return true, errors.New("invalid installation shutdown response")
			}
		}
		time.Sleep(setupExitPoll)
	}
	return true, errSetupBusy
}
