package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const removalProcessQuery = 0x1000

// Observe only the updater in this exact installation, never a global image-name
// match. No directory pins are retained while the official remover needs them.
func updaterActive(root string) (bool, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer syscall.CloseHandle(snapshot)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		if !strings.EqualFold(syscall.UTF16ToString(entry.ExeFile[:]), "Update.exe") {
			continue
		}
		process, openErr := syscall.OpenProcess(removalProcessQuery, false, entry.ProcessID)
		if errors.Is(openErr, syscall.Errno(87)) {
			continue
		} // Exited since the snapshot.
		if openErr != nil {
			return false, openErr
		}
		var path [32768]uint16
		length := uint32(len(path))
		ok, _, queryErr := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(process), 0, uintptr(unsafe.Pointer(&path[0])), uintptr(unsafe.Pointer(&length)))
		syscall.CloseHandle(process)
		if ok == 0 {
			if errors.Is(queryErr, syscall.Errno(87)) {
				continue
			}
			return false, queryErr
		}
		imageRoot, err := canonicalDirectory(filepath.Dir(syscall.UTF16ToString(path[:length])))
		if err != nil {
			return false, err
		}
		if strings.EqualFold(imageRoot, root) {
			return true, nil
		}
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		return false, err
	}
	return false, nil
}

func inspectRemoval(root, appID string) (removalState, error) {
	var state removalState
	canonical, err := canonicalDirectory(root)
	if err != nil {
		return state, &directoryIssue{Code: directoryInspection, Path: root, Cause: err}
	}
	state.active, err = updaterActive(canonical)
	if err != nil {
		return state, &directoryIssue{Code: directoryInspection, Path: root, Cause: err}
	}
	_, err = os.Lstat(root)
	state.absent = os.IsNotExist(err)
	if err != nil && !state.absent {
		return state, err
	}
	if state.absent {
		return state, nil
	}
	if err = verifyInstalled(root, appID); err == nil {
		state.complete = true
		return state, nil
	}
	if !os.IsNotExist(err) {
		return state, nil
	} // Normal preflight owns other invalid trees.
	// A surviving updater with no complete application is a partial removal,
	// including the delay after the updater has already exited.
	_, updaterErr := os.Lstat(filepath.Join(root, "Update.exe"))
	state.incomplete = updaterErr == nil
	if updaterErr != nil && !os.IsNotExist(updaterErr) {
		return state, updaterErr
	}
	return state, nil
}
