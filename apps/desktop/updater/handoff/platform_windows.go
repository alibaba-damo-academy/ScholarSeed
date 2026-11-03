//go:build windows

package handoff

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	aclpolicy "scholarseed.local/desktop/updater/internal/security"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var shell = syscall.NewLazyDLL("shell32.dll")
var security = syscall.NewLazyDLL("advapi32.dll")

const componentFlushWorkers = 4

func checkLineage(filename string) error {
	if !filepath.IsAbs(filename) || strings.HasPrefix(filename, `\\`) {
		return errors.New("absolute local Windows path required")
	}
	parents, err := pinLineage(filepath.Dir(filename))
	if err != nil {
		return err
	}
	defer closeFiles(parents)
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return err
	}
	h, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("reparse point rejected: %s", filename)
	}
	return nil
}
func pinFile(filename string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(handle, &info); err != nil || info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		syscall.CloseHandle(handle)
		return nil, errors.New("input is not a regular unlinked file")
	}
	return os.NewFile(uintptr(handle), filename), nil
}
func checkSpace(root string, required int64) error {
	path, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return err
	}
	var available uint64
	ok, _, callErr := kernel.NewProc("GetDiskFreeSpaceExW").Call(uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&available)), 0, 0)
	if ok == 0 {
		return callErr
	}
	if required < 0 || available < uint64(required)+64*1024*1024 {
		return errors.New("insufficient component disk space")
	}
	return nil
}
func rootWritable(root string) bool {
	name, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return false
	}
	// Request directory create-child rights without creating a probe file.
	h, err := syscall.CreateFile(name, 0x00000006, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false
	}
	syscall.CloseHandle(h)
	return true
}
func installationLock(root string) (func(), error) {
	filename := filepath.Join(root, ".scholarseed-runtime.lock")
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, fmt.Errorf("installation is busy: %w", err)
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_DIRECTORY|syscall.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		syscall.CloseHandle(h)
		return nil, errors.New("invalid installation lock")
	}
	return func() { syscall.CloseHandle(h) }, nil
}

func pinDirectory(filename string) (*os.File, error) {
	return pinDirectorySharing(filename, 0x80, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE)
}

// Cached extraction pins must block directory mutation as well as replacement.
// In particular, a retained path must not become a reparse point after validation.
// Child file creation does not require write access to the directory handle.
func pinExtractionDirectory(filename string) (*os.File, error) {
	// Attribute-only opens do not participate in Windows data-sharing checks.
	// Include LIST_DIRECTORY so deny-write sharing actually blocks mutation.
	return pinDirectorySharing(filename, 0x80|syscall.FILE_LIST_DIRECTORY, syscall.FILE_SHARE_READ)
}

func pinDirectorySharing(filename string, access, sharing uint32) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(name, access, sharing, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
		syscall.CloseHandle(h)
		return nil, errors.New("invalid directory")
	}
	return os.NewFile(uintptr(h), filename), nil
}
func holdStage(filename string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(name, 0x10000|0x80|syscall.SYNCHRONIZE|toolReadControl|toolWriteDACL|syscall.FILE_LIST_DIRECTORY, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
		syscall.CloseHandle(h)
		return nil, errors.New("invalid preparation directory")
	}
	return os.NewFile(uintptr(h), filename), nil
}

type renameInformation struct {
	Replace byte
	Root    syscall.Handle
	Length  uint32
	Name    [256]uint16
}
type ioStatus struct {
	Status      uintptr
	Information uintptr
}

func publishStage(stage *os.File, from, to string) error {
	if filepath.Dir(from) != filepath.Dir(to) {
		return errors.New("component publication changed parent")
	}
	parent, err := pinDirectory(filepath.Dir(to))
	if err != nil {
		return err
	}
	defer parent.Close()
	name, err := syscall.UTF16FromString(filepath.Base(to))
	if err != nil || len(name) > 256 {
		return errors.New("invalid component version")
	}
	info := renameInformation{Root: syscall.Handle(parent.Fd()), Length: uint32((len(name) - 1) * 2)}
	copy(info.Name[:], name)
	var status ioStatus
	nt := syscall.NewLazyDLL("ntdll.dll")
	code, _, _ := nt.NewProc("NtSetInformationFile").Call(stage.Fd(), uintptr(unsafe.Pointer(&status)), uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), 10)
	if int32(code) < 0 {
		win, _, _ := nt.NewProc("RtlNtStatusToDosError").Call(code)
		return syscall.Errno(win)
	}
	return nil
}

func verifyAuthenticode(filename string, signing Signing) error {
	return verifyAuthenticodeFiles([]string{filename}, signing)
}

// Batch only within one pinned validation scope; every file must independently
// pass the unchanged Windows trust and exact publisher checks. No trust cache.
func verifyAuthenticodeFiles(filenames []string, signing Signing) error {
	if len(filenames) == 0 {
		return errors.New("no executables to authenticate")
	}
	if signing.Mode == "unsigned-dev" {
		return nil
	}
	if signing.Mode != "authenticode" || signing.Publisher == "" {
		return errors.New("missing compiled Authenticode policy")
	}
	var files []*os.File
	defer func() { closeFiles(files) }()
	for _, filename := range filenames {
		file, err := pinFile(filename)
		if err != nil {
			return err
		}
		files = append(files, file)
		subject, err := nativeSignature(file)
		if err != nil {
			return err
		}
		if err = signaturePublisher(subject, signing.Publisher); err != nil {
			return err
		}
	}
	return nil
}

type windowsWaiter struct{ handle syscall.Handle }

func (w *windowsWaiter) Close() error { return syscall.CloseHandle(w.handle) }
func (w *windowsWaiter) Wait(timeout time.Duration) error {
	value, err := syscall.WaitForSingleObject(w.handle, uint32(timeout/time.Millisecond))
	if err != nil {
		return err
	}
	if value != syscall.WAIT_OBJECT_0 {
		return errors.New("process exit timeout")
	}
	return nil
}
func (w *windowsWaiter) Alive() bool {
	value, err := syscall.WaitForSingleObject(w.handle, 0)
	return err == nil && value == syscall.WAIT_TIMEOUT
}
func openProcessWaiter(pid uint32) (processWaiter, error) {
	const processQueryLimitedInformation = 0x1000
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE|processQueryLimitedInformation, false, pid)
	if err != nil {
		return nil, err
	}
	return &windowsWaiter{h}, nil
}
func hideProcess(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func restart(executable string, args []string) (int, error) {
	if err := checkLineage(executable); err != nil {
		return 0, err
	}
	command := exec.Command(executable, args...)
	command.Dir = filepath.Dir(executable)
	hideProcess(command)
	if err := command.Start(); err != nil {
		return 0, err
	}
	pid := command.Process.Pid
	return pid, command.Process.Release()
}

type windowsWorker struct{ handle syscall.Handle }

func (w *windowsWorker) Close() error     { return syscall.CloseHandle(w.handle) }
func (w *windowsWorker) Terminate() error { return syscall.TerminateProcess(w.handle, 1) }
func (w *windowsWorker) Done() (bool, error) {
	value, err := syscall.WaitForSingleObject(w.handle, 0)
	if err != nil {
		return false, err
	}
	return value == syscall.WAIT_OBJECT_0, nil
}
func (w *windowsWorker) Wait(timeout time.Duration) (uint32, error) {
	value, err := syscall.WaitForSingleObject(w.handle, uint32(timeout/time.Millisecond))
	if err != nil {
		return 0, err
	}
	if value != syscall.WAIT_OBJECT_0 {
		return 0, errors.New("process wait timeout")
	}
	var code uint32
	if err = syscall.GetExitCodeProcess(w.handle, &code); err != nil {
		return 0, err
	}
	return code, nil
}
func pinLineage(filename string) ([]*os.File, error) {
	const directoryTraverse = 0x20
	if !filepath.IsAbs(filename) || strings.HasPrefix(filename, `\\`) {
		return nil, errors.New("absolute local Windows path required")
	}
	var files []*os.File
	var names []string
	for current := filepath.Clean(filename); ; current = filepath.Dir(current) {
		names = append(names, current)
		if filepath.Dir(current) == current {
			break
		}
	}
	// Resolve each child only after holding its ancestor against replacement.
	for i := len(names) - 1; i >= 0; i-- {
		current := names[i]
		name, err := syscall.UTF16PtrFromString(current)
		if err != nil {
			for _, f := range files {
				f.Close()
			}
			return nil, err
		}
		// Metadata handles need no directory listing rights. Cross-user workers
		// use traversal plus explicit file grants, not broader directory ACLs.
		h, err := syscall.CreateFile(name, directoryTraverse, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			for _, f := range files {
				f.Close()
			}
			return nil, err
		}
		var info syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			syscall.CloseHandle(h)
			for _, f := range files {
				f.Close()
			}
			return nil, errors.New("unsafe input ancestor")
		}
		files = append(files, os.NewFile(uintptr(h), current))
	}
	return files, nil
}

// ShellExecuteEx keeps the original coordinator alive with its original token.
// The worker never launches the application.
type shellExecuteInfo struct {
	Size       uint32
	Mask       uint32
	Window     uintptr
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	Show       int32
	Instance   uintptr
	IDList     uintptr
	Class      *uint16
	ClassKey   uintptr
	HotKey     uint32
	Icon       uintptr
	Process    syscall.Handle
}

func startWorker(executable string, args []string, elevate bool) (workerProcess, error) {
	if !elevate {
		command := exec.Command(executable, args...)
		hideProcess(command)
		if err := command.Start(); err != nil {
			return nil, err
		}
		h, err := syscall.OpenProcess(syscall.SYNCHRONIZE|syscall.PROCESS_QUERY_INFORMATION|syscall.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
		if err != nil {
			command.Process.Kill()
			command.Wait()
			return nil, err
		}
		command.Process.Release()
		return &windowsWorker{h}, nil
	}
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString(executable)
	parameters := make([]string, len(args))
	for i, arg := range args {
		parameters[i] = syscall.EscapeArg(arg)
	}
	parameter, _ := syscall.UTF16PtrFromString(strings.Join(parameters, " "))
	directory, _ := syscall.UTF16PtrFromString(filepath.Dir(executable))
	info := shellExecuteInfo{Mask: 0x40 | 0x100 | 0x400, Verb: verb, File: file, Parameters: parameter, Directory: directory, Show: 0}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, err := shell.NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		if err == syscall.Errno(1223) {
			return nil, ErrCancelled
		}
		return nil, err
	}
	if info.Process == 0 {
		return nil, errors.New("elevation returned no process handle")
	}
	return &windowsWorker{info.Process}, nil
}

type trustee struct {
	Multiple  uintptr
	Operation uint32
	Form      uint32
	Type      uint32
	Name      *uint16
}
type explicitAccess struct {
	Permissions uint32
	Mode        uint32
	Inheritance uint32
	Trustee     trustee
}

func grantAdministrators(filename string, write bool) error {
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return err
	}
	h, err := syscall.CreateFile(name, 0x00020000|0x00040000, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return errors.New("ACL grant requires a regular file")
	}
	var oldACL, descriptor uintptr
	code, _, _ := security.NewProc("GetSecurityInfo").Call(uintptr(h), 1, 4, 0, 0, uintptr(unsafe.Pointer(&oldACL)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if code != 0 {
		return syscall.Errno(code)
	}
	defer kernel.NewProc("LocalFree").Call(descriptor)
	// A null DACL already grants access. Converting it into a restrictive ACL is
	// not necessary to make this public verified input readable.
	if oldACL == 0 {
		return nil
	}
	sidText, _ := syscall.UTF16PtrFromString(aclpolicy.SidAdministrators)
	var sid *uint16
	ok, _, callErr := security.NewProc("ConvertStringSidToSidW").Call(uintptr(unsafe.Pointer(sidText)), uintptr(unsafe.Pointer(&sid)))
	if ok == 0 {
		return callErr
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(unsafe.Pointer(sid)))
	permissions := uint32(0x00120089)
	if write {
		permissions |= 0x00120116
	}
	entry := explicitAccess{Permissions: permissions, Mode: 1, Trustee: trustee{Form: 0, Type: 2, Name: sid}}
	var newACL uintptr
	code, _, _ = security.NewProc("SetEntriesInAclW").Call(1, uintptr(unsafe.Pointer(&entry)), oldACL, uintptr(unsafe.Pointer(&newACL)))
	if code != 0 {
		return syscall.Errno(code)
	}
	defer kernel.NewProc("LocalFree").Call(newACL)
	code, _, _ = security.NewProc("SetSecurityInfo").Call(uintptr(h), 1, 4, 0, 0, newACL, 0)
	if code != 0 {
		return syscall.Errno(code)
	}
	return nil
}

func openChannel(filename string, write bool) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	access := uint32(syscall.GENERIC_READ)
	if write {
		access |= syscall.GENERIC_WRITE
	}
	h, err := syscall.CreateFile(name, access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil || info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		syscall.CloseHandle(h)
		return nil, errors.New("invalid worker channel file")
	}
	return os.NewFile(uintptr(h), filename), nil
}
