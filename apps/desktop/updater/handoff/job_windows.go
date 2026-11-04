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
const jobPollInterval = 25 * time.Millisecond

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
func (job *windowsJob) Terminate() error {
	ok, _, err := kernel.NewProc("TerminateJobObject").Call(uintptr(job.handle), 1)
	if ok == 0 {
		return err
	}
	return nil
}
func (j *windowsJob) Wait(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var accounting jobAccounting
		ok, _, err := kernel.NewProc("QueryInformationJobObject").Call(uintptr(j.handle), 1, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
		if ok == 0 {
			return err
		}
		if accounting.Active == 0 {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return errors.New("updater process family did not exit")
		}
		if remaining > jobPollInterval {
			remaining = jobPollInterval
		}
		time.Sleep(remaining)
	}
}

type updaterJob struct {
	handle   syscall.Handle
	admitted bool
}

func openUpdaterJob(nonce string) (updaterInvocation, error) {
	name, _ := syscall.UTF16PtrFromString(jobPrefix + nonce)
	h, _, err := kernel.NewProc("OpenJobObjectW").Call(0x0001|0x0004, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return nil, err
	}
	return &updaterJob{handle: syscall.Handle(h)}, nil
}
func (j *updaterJob) Close() error {
	if j.handle == 0 {
		return nil
	}
	handle := j.handle
	j.handle = 0
	return syscall.CloseHandle(handle)
}
func (job *updaterJob) Admit() error {
	if job.admitted || job.handle == 0 {
		return errors.New("updater worker job admission is unavailable")
	}
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		return err
	}
	ok, _, err := kernel.NewProc("AssignProcessToJobObject").Call(uintptr(job.handle), uintptr(process))
	if ok == 0 {
		return err
	}
	if err = job.Close(); err != nil {
		return err
	}
	job.admitted = true
	return nil
}
func (j *updaterJob) Run(executable string, args []string) error {
	if !j.admitted || j.handle != 0 {
		return errors.New("updater worker has not completed job admission")
	}
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
	startup := syscall.StartupInfo{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = syscall.STARTF_USESHOWWINDOW
	startup.ShowWindow = syscall.SW_HIDE
	var process syscall.ProcessInformation
	if err = syscall.CreateProcess(exe, line, nil, nil, false, 0x08000000, nil, directory, &startup, &process); err != nil {
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
