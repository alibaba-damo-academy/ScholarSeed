package main

import (
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"unsafe"
)

const (
	setupProcessQuery         = 0x1000
	setupProcessNameNative    = 1
	setupVolumeNameNT         = 2
	setupProcessIDInformation = 88
	setupImagePathUnits       = 32760
)

var setupQuerySystemInformation = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQuerySystemInformation")

// SYSTEM_PROCESS_ID_INFORMATION contains a pointer-sized PID and UNICODE_STRING.
type setupProcessInformation struct {
	pid   uintptr
	image struct {
		length, maximum uint16
		buffer          *uint16
	}
}

func setupRelevantImage(name string) bool {
	name = strings.ToLower(name)
	return name == "scholarseed.exe" || name == "scholarseedengine.exe" || name == "update.exe" || legacyRuntimeImage(name)
}

func setupProcessImage(pid uint32, flags uint32) (string, error) {
	process, err := syscall.OpenProcess(setupProcessQuery, false, pid)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(process)
	var image [32768]uint16
	length := uint32(len(image))
	ok, _, err := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(process), uintptr(flags), uintptr(unsafe.Pointer(&image[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return "", err
	}
	return syscall.UTF16ToString(image[:length]), nil
}

// Match the read-only system query used by native update handoff when the
// target process cannot be opened. No process permissions are changed.
func setupSystemProcessImage(pid uint32) (string, error) {
	if err := setupQuerySystemInformation.Find(); err != nil {
		return "", err
	}
	var image [setupImagePathUnits]uint16
	info := setupProcessInformation{pid: uintptr(pid)}
	info.image.buffer = &image[0]
	info.image.maximum = uint16(unsafe.Sizeof(image))
	status, _, _ := setupQuerySystemInformation.Call(setupProcessIDInformation, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), 0)
	runtime.KeepAlive(&image)
	if int32(status) < 0 {
		return "", fmt.Errorf("query process image: NTSTATUS %#08x", uint32(status))
	}
	length := int(info.image.length) / 2
	if info.image.buffer != &image[0] || info.image.length%2 != 0 || length == 0 || length >= len(image) || slices.Contains(image[:length], 0) {
		return "", errors.New("invalid system process image")
	}
	path := syscall.UTF16ToString(image[:length])
	if !strings.HasPrefix(path, "\\Device\\") {
		return "", errors.New("system process image has no NT device path")
	}
	return path, nil
}

func setupInstallationPath(root string) (string, error) {
	const readAttributes = 0x80
	directory, err := syscall.CreateFile(utf(root), readAttributes,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(directory)
	var path [setupImagePathUnits]uint16
	length, _, err := kernel.NewProc("GetFinalPathNameByHandleW").Call(uintptr(directory), uintptr(unsafe.Pointer(&path[0])), uintptr(len(path)), setupVolumeNameNT)
	if length == 0 {
		return "", err
	}
	if length >= uintptr(len(path)) {
		return "", syscall.ERROR_INSUFFICIENT_BUFFER
	}
	return syscall.UTF16ToString(path[:length]), nil
}

// Observation never grants termination authority. Unknown relevant images block
// replacement; unrelated installations are distinguished by canonical paths.
func installationActive(root string) (bool, error) {
	canonical, err := setupInstallationPath(root)
	if err != nil {
		return false, err
	}
	prefix := strings.ToLower(strings.TrimRight(canonical, "\\")) + "\\"
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer syscall.CloseHandle(snapshot)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		image, queryErr := setupProcessImage(entry.ProcessID, setupProcessNameNative)
		if queryErr != nil {
			name := syscall.UTF16ToString(entry.ExeFile[:])
			if errors.Is(queryErr, syscall.Errno(87)) || !setupRelevantImage(name) {
				continue
			}
			var fallbackErr error
			image, fallbackErr = setupSystemProcessImage(entry.ProcessID)
			if fallbackErr != nil {
				return false, queryErr
			}
		}
		if strings.HasPrefix(strings.ToLower(image), prefix) {
			return true, nil
		}
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		return false, err
	}
	return false, nil
}
