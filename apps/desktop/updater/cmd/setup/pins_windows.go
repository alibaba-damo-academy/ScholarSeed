package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	installationPinAccess          = 0x00000020 | 0x00000080 | 0x00020000
	installationPinSynchronize     = 0x00100000
	installationPinCaseInsensitive = 0x00000040
	installationPinCreate          = 2
	installationPinCreated         = 2
	installationPinDirectory       = 0x00000001
	installationPinSynchronous     = 0x00000020
	installationPinReparse         = 0x00200000
	installationPinSDDLRevision    = 1
	installationPinMaxNameUnits    = 32766
)

var installationPinNT = syscall.NewLazyDLL("ntdll.dll")

type installationPinName struct {
	length  uint16
	maximum uint16
	buffer  *uint16
}

type installationPinAttributes struct {
	length     uint32
	parent     syscall.Handle
	name       *installationPinName
	attributes uint32
	security   unsafe.Pointer
	quality    unsafe.Pointer
}

type installationPinStatus struct {
	status      uintptr
	information uintptr
}

type installationPin struct {
	path   string
	handle syscall.Handle
}

type installationPins struct {
	handles   []installationPin
	remaining []string
	closed    bool
}

func pinInstallationParent(root string) (*installationPins, error) {
	clean := filepath.Clean(root)
	volume := filepath.VolumeName(clean)
	if !filepath.IsAbs(root) || len(volume) != 2 || volume[1] != ':' || strings.ContainsRune(root, 0) {
		return nil, fmt.Errorf("installation pin requires an absolute drive path: %q", root)
	}
	paths := []string{volume + `\`}
	if clean != paths[0] {
		for _, part := range strings.Split(strings.TrimPrefix(clean, paths[0]), `\`) {
			paths = append(paths, filepath.Join(paths[len(paths)-1], part))
		}
	}
	pins := &installationPins{}
	for index, path := range paths {
		handle, err := openInstallationPin(path)
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND) {
			pins.remaining = paths[index:]
			return pins, nil
		}
		if err != nil {
			return nil, errors.Join(err, pins.close())
		}
		pins.handles = append(pins.handles, installationPin{path: path, handle: handle})
	}
	return pins, nil
}

func openInstallationPin(path string) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return syscall.InvalidHandle, fmt.Errorf("pin installation directory %q: %w", path, err)
	}
	handle, err := syscall.CreateFile(name, installationPinAccess, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return syscall.InvalidHandle, fmt.Errorf("pin installation directory %q: %w", path, err)
	}
	return inspectInstallationPin(path, handle)
}

func inspectInstallationPin(path string, handle syscall.Handle) (syscall.Handle, error) {
	var info syscall.ByHandleFileInformation
	err := syscall.GetFileInformationByHandle(handle, &info)
	if err == nil && (info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0) {
		err = fmt.Errorf("installation pin requires a directory without reparse points")
	}
	if err != nil {
		return syscall.InvalidHandle, errors.Join(fmt.Errorf("inspect installation pin %q: %w", path, err), closeInstallationPin(installationPin{path: path, handle: handle}))
	}
	return handle, nil
}

func installationPinSecurity() (unsafe.Pointer, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return nil, err
	}
	user, userErr := token.GetTokenUser()
	if err = errors.Join(userErr, token.Close()); err != nil {
		return nil, err
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return nil, err
	}
	text, err := syscall.UTF16PtrFromString("O:" + sid + "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return nil, err
	}
	var descriptor unsafe.Pointer
	ok, _, err := permissionAPI.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(text)), installationPinSDDLRevision, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return nil, fmt.Errorf("create installation pin security descriptor: %w", err)
	}
	return descriptor, nil
}

func createInstallationPin(parent installationPin, path string, security unsafe.Pointer) (syscall.Handle, error) {
	if !strings.EqualFold(filepath.Dir(path), parent.path) || security == nil {
		return syscall.InvalidHandle, errors.New("installation pin requires its pinned direct parent and private security descriptor")
	}
	part := filepath.Base(path)
	if part == "." || part == ".." || strings.ContainsAny(part, `\/:`) {
		return syscall.InvalidHandle, fmt.Errorf("invalid installation pin child name: %q", part)
	}
	name, err := syscall.UTF16FromString(part)
	if err != nil || len(name)-1 > installationPinMaxNameUnits {
		return syscall.InvalidHandle, fmt.Errorf("invalid installation pin child name: %q", part)
	}
	create := installationPinNT.NewProc("NtCreateFile")
	translate := installationPinNT.NewProc("RtlNtStatusToDosError")
	if err = errors.Join(create.Find(), translate.Find()); err != nil {
		return syscall.InvalidHandle, err
	}
	unicode := installationPinName{length: uint16(2 * (len(name) - 1)), maximum: uint16(2 * len(name)), buffer: &name[0]}
	attributes := installationPinAttributes{parent: parent.handle, name: &unicode, attributes: installationPinCaseInsensitive, security: security}
	attributes.length = uint32(unsafe.Sizeof(attributes))
	var status installationPinStatus
	handle := syscall.InvalidHandle
	code, _, _ := create.Call(uintptr(unsafe.Pointer(&handle)), installationPinAccess|installationPinSynchronize, uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(&status)), 0, syscall.FILE_ATTRIBUTE_DIRECTORY, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, installationPinCreate, installationPinDirectory|installationPinSynchronous|installationPinReparse, 0, 0)
	runtime.KeepAlive(name)
	runtime.KeepAlive(unicode)
	runtime.KeepAlive(attributes)
	if int32(code) < 0 {
		win, _, _ := translate.Call(uintptr(uint32(code)))
		return syscall.InvalidHandle, fmt.Errorf("create pinned installation directory %q (NTSTATUS 0x%08x): %w", path, uint32(code), syscall.Errno(win))
	}
	if code != 0 || status.information != installationPinCreated || handle == syscall.InvalidHandle || handle == 0 {
		failure := fmt.Errorf("unexpected installation directory creation result for %q: NTSTATUS=0x%08x, information=%d", path, uint32(code), status.information)
		if handle != syscall.InvalidHandle && handle != 0 {
			failure = errors.Join(failure, closeInstallationPin(installationPin{path: path, handle: handle}))
		}
		return syscall.InvalidHandle, failure
	}
	return inspectInstallationPin(path, handle)
}

func (pins *installationPins) prepare() (prepareErr error) {
	if pins == nil || pins.closed {
		return errors.New("installation pins are closed")
	}
	if len(pins.remaining) == 0 {
		return nil
	}
	if len(pins.handles) == 0 {
		return errors.New("installation drive root is not pinned")
	}
	security, err := installationPinSecurity()
	if err != nil {
		return err
	}
	defer func() {
		remaining, _, freeErr := kernel.NewProc("LocalFree").Call(uintptr(security))
		if remaining != 0 {
			prepareErr = errors.Join(prepareErr, fmt.Errorf("free installation pin security descriptor: %w", freeErr))
		}
	}()
	for len(pins.remaining) > 0 {
		path := pins.remaining[0]
		handle, err := createInstallationPin(pins.handles[len(pins.handles)-1], path, security)
		if err != nil {
			return err
		}
		pins.handles = append(pins.handles, installationPin{path: path, handle: handle})
		pins.remaining = pins.remaining[1:]
	}
	return nil
}

func closeInstallationPin(pin installationPin) error {
	if err := syscall.CloseHandle(pin.handle); err != nil {
		return fmt.Errorf("close installation pin %q: %w", pin.path, err)
	}
	return nil
}

// replace hands only the installation leaf to the official engine. Ancestors
// remain pinned while the engine renames the old root and creates its replacement.
// A successful replacement must be pinned again before verification or ACL work.
func (pins *installationPins) replace(root string, install func() error) error {
	if pins == nil || pins.closed || len(pins.remaining) != 0 || len(pins.handles) < 2 {
		return errors.New("installation replacement requires a prepared leaf and pinned parent")
	}
	last := len(pins.handles) - 1
	leaf := pins.handles[last]
	if !strings.EqualFold(filepath.Clean(root), leaf.path) ||
		!strings.EqualFold(filepath.Dir(leaf.path), pins.handles[last-1].path) {
		return errors.New("installation replacement requires the pinned installation leaf")
	}
	if err := closeInstallationPin(leaf); err != nil {
		return err
	}
	pins.handles = pins.handles[:last]
	if err := install(); err != nil {
		return err
	}
	handle, err := openInstallationPin(leaf.path)
	if err != nil {
		return &directoryIssue{Code: directoryInspection, Path: leaf.path, Cause: err}
	}
	pins.handles = append(pins.handles, installationPin{path: leaf.path, handle: handle})
	return nil
}

func (pins *installationPins) close() error {
	if pins == nil {
		return nil
	}
	pins.closed = true
	handles := pins.handles
	pins.handles = nil
	var failures []error
	for index := len(handles) - 1; index >= 0; index-- {
		if err := closeInstallationPin(handles[index]); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
