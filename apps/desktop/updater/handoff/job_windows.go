//go:build windows

package handoff

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const jobPrefix = `Local\ScholarSeedHandoff-`

type windowsJob struct{ handle syscall.Handle }
type jobLimits struct {
	ProcessTime   int64
	JobTime       int64
	Flags         uint32
	Minimum       uintptr
	Maximum       uintptr
	Active        uint32
	Affinity      uintptr
	Priority      uint32
	Scheduling    uint32
	ReadOps       uint64
	WriteOps      uint64
	OtherOps      uint64
	ReadBytes     uint64
	WriteBytes    uint64
	OtherBytes    uint64
	ProcessMemory uintptr
	JobMemory     uintptr
	PeakProcess   uintptr
	PeakJob       uintptr
}
type jobAccounting struct {
	User         int64
	Kernel       int64
	PeriodUser   int64
	PeriodKernel int64
	Faults       uint32
	Total        uint32
	Active       uint32
	Terminated   uint32
}

func newUpdateJob(nonce string) (updateJob, error) {
	// OW is the object's owner. Only that user, administrators and SYSTEM can
	// assign or terminate processes; this does not expose a machine-wide API.
	sddl, _ := syscall.UTF16PtrFromString("D:P(A;;GA;;;OW)(A;;GA;;;BA)(A;;GA;;;SY)")
	var descriptor uintptr
	ok, _, err := security.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return nil, err
	}
	defer kernel.NewProc("LocalFree").Call(descriptor)
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	name, _ := syscall.UTF16PtrFromString(jobPrefix + nonce)
	h, _, err := kernel.NewProc("CreateJobObjectW").Call(uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return nil, err
	}
	job := &windowsJob{syscall.Handle(h)}
	if err == syscall.ERROR_ALREADY_EXISTS {
		job.Close()
		return nil, errors.New("handoff job already exists")
	}
	limits := jobLimits{Flags: 0x2000}
	ok, _, err = kernel.NewProc("SetInformationJobObject").Call(h, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		job.Close()
		return nil, err
	}
	return job, nil
}
func (j *windowsJob) Close() error { return syscall.CloseHandle(j.handle) }
func (j *windowsJob) Quiesce(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	terminated := false
	for time.Now().Before(deadline) {
		var accounting jobAccounting
		ok, _, err := kernel.NewProc("QueryInformationJobObject").Call(uintptr(j.handle), 1, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
		if ok == 0 {
			return err
		}
		if accounting.Active == 0 {
			return nil
		}
		// The worker has already exited. Any remaining updater descendants are
		// this invocation's processes, and must finish before app restoration.
		if !terminated {
			ok, _, err = kernel.NewProc("TerminateJobObject").Call(uintptr(j.handle), 1)
			if ok == 0 {
				return err
			}
			terminated = true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return errors.New("updater process family did not exit")
}

type updaterJob struct {
	handle     syscall.Handle
	attributes []byte
}

func openUpdaterJob(nonce string) (updaterInvocation, error) {
	name, _ := syscall.UTF16PtrFromString(jobPrefix + nonce)
	h, _, err := kernel.NewProc("OpenJobObjectW").Call(0x0001|0x0004, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return nil, err
	}
	j := &updaterJob{handle: syscall.Handle(h)}
	var size uintptr
	initialize := kernel.NewProc("InitializeProcThreadAttributeList")
	initialize.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 65536 {
		j.Close()
		return nil, errors.New("invalid process attribute size")
	}
	j.attributes = make([]byte, size)
	ok, _, err := initialize.Call(uintptr(unsafe.Pointer(&j.attributes[0])), 1, 0, uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		j.attributes = nil
		j.Close()
		return nil, err
	}
	// Windows 10 JOB_LIST assigns the process atomically at creation, avoiding
	// an orphan between suspended creation and a separate assignment call.
	ok, _, err = kernel.NewProc("UpdateProcThreadAttribute").Call(uintptr(unsafe.Pointer(&j.attributes[0])), 0, 0x0002000d, uintptr(unsafe.Pointer(&j.handle)), unsafe.Sizeof(j.handle), 0, 0)
	if ok == 0 {
		j.Close()
		return nil, err
	}
	return j, nil
}
func (j *updaterJob) Close() error {
	if len(j.attributes) != 0 {
		kernel.NewProc("DeleteProcThreadAttributeList").Call(uintptr(unsafe.Pointer(&j.attributes[0])))
		j.attributes = nil
	}
	return syscall.CloseHandle(j.handle)
}
func (j *updaterJob) Run(executable string, args []string) error {
	quoted := []string{syscall.EscapeArg(executable)}
	for _, arg := range args {
		quoted = append(quoted, syscall.EscapeArg(arg))
	}
	line, err := syscall.UTF16PtrFromString(strings.Join(quoted, " "))
	if err != nil {
		return err
	}
	exe, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return err
	}
	directory, _ := syscall.UTF16PtrFromString(filepath.Dir(executable))
	startup := struct {
		info       syscall.StartupInfo
		attributes *byte
	}{attributes: &j.attributes[0]}
	startup.info.Cb = uint32(unsafe.Sizeof(startup))
	startup.info.Flags = syscall.STARTF_USESHOWWINDOW
	startup.info.ShowWindow = syscall.SW_HIDE
	var process syscall.ProcessInformation
	if err = syscall.CreateProcess(exe, line, nil, nil, false, 0x00080000|0x08000000, nil, directory, &startup.info, &process); err != nil {
		return err
	}
	defer syscall.CloseHandle(process.Process)
	defer syscall.CloseHandle(process.Thread)
	value, err := syscall.WaitForSingleObject(process.Process, syscall.INFINITE)
	if err != nil {
		return err
	}
	if value != syscall.WAIT_OBJECT_0 {
		return errors.New("updater wait failed")
	}
	var code uint32
	if err = syscall.GetExitCodeProcess(process.Process, &code); err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("official updater failed (%d)", code)
	}
	return nil
}
