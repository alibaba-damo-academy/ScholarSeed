//go:build windows

package handoff

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

const (
	jobGateMarker         = "handoff-job-ownership"
	jobGateWait           = 15 * time.Second
	jobGateUACWait        = 90 * time.Second
	jobGateLifetime       = 2 * time.Minute
	jobGatePoll           = 10 * time.Millisecond
	jobGateQuery          = 0x0004
	jobGateTerminate      = 0x0008
	jobGateBreakaway      = 0x01000000
	jobGateLimitedQuery   = 0x1000
	jobGateSetQuota       = 0x0100
	jobGateElevation      = 20
	jobGateUACEnvironment = "SCHOLARSEED_TEST_UPDATER_JOB_UAC"
)

type jobGateRecord struct {
	PID      uint32
	ChildPID uint32
	SID      string
	Elevated bool
}

func jobGateIdentity() (jobGateRecord, error) {
	record := jobGateRecord{PID: uint32(os.Getpid())}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return record, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return record, err
	}
	record.SID, err = user.User.Sid.String()
	if err != nil {
		return record, err
	}
	var elevated, returned uint32
	ok, _, callErr := security.NewProc("GetTokenInformation").Call(uintptr(token), jobGateElevation, uintptr(unsafe.Pointer(&elevated)), unsafe.Sizeof(elevated), uintptr(unsafe.Pointer(&returned)))
	if ok == 0 {
		return record, callErr
	}
	record.Elevated = elevated != 0
	return record, nil
}

func jobGateArguments(role, directory, nonce, mode string) []string {
	return []string{"-test.run=^TestUpdaterJobOwnershipProcess$", "--", jobGateMarker, role, directory, nonce, mode}
}

func jobGateWrite(directory, name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(directory, name), raw, 0600)
}

func jobGateRead(directory, name string, timeout time.Duration) (jobGateRecord, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, role := range []string{"coordinator", "worker", "descendant"} {
			if raw, err := os.ReadFile(filepath.Join(directory, "failure-"+role)); err == nil {
				return jobGateRecord{}, fmt.Errorf("%s: %s", role, raw)
			}
		}
		var record jobGateRecord
		if raw, err := os.ReadFile(filepath.Join(directory, name)); err == nil && json.Unmarshal(raw, &record) == nil {
			return record, nil
		}
		time.Sleep(jobGatePoll)
	}
	return jobGateRecord{}, fmt.Errorf("job gate timed out waiting for %s", name)
}

func jobGateOpen(nonce string, access uintptr) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(jobPrefix + nonce)
	if err != nil {
		return 0, err
	}
	handle, _, callErr := kernel.NewProc("OpenJobObjectW").Call(access, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return 0, callErr
	}
	return syscall.Handle(handle), nil
}

func jobGateAssign(job, process syscall.Handle) error {
	ok, _, err := kernel.NewProc("AssignProcessToJobObject").Call(uintptr(job), uintptr(process))
	if ok == 0 {
		return err
	}
	return nil
}

func jobGateContains(job, process syscall.Handle) error {
	var member int32
	ok, _, err := kernel.NewProc("IsProcessInJob").Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&member)))
	if ok == 0 {
		return err
	}
	if member == 0 {
		return errors.New("process escaped the invocation job")
	}
	return nil
}

func jobGateWorker(executable, directory, nonce, mode string) error {
	invocation, err := openUpdaterJob(nonce)
	if err != nil {
		return err
	}
	defer invocation.Close()
	if err = invocation.Admit(); err != nil {
		return err
	}
	unlock, err := installationLock(directory)
	if err != nil {
		return err
	}
	defer unlock()
	finished := make(chan error, 1)
	go func() {
		finished <- invocation.Run(executable, jobGateArguments("descendant", directory, nonce, mode))
	}()
	descendant, err := jobGateRead(directory, "descendant", jobGateWait)
	if err != nil {
		return err
	}
	select {
	case err = <-finished:
		return fmt.Errorf("updater child exited before authorization: %v", err)
	default:
	}
	breakaway := exec.Command(executable, jobGateArguments("descendant", directory, nonce, mode)...)
	breakaway.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: jobGateBreakaway}
	if err = breakaway.Start(); err == nil {
		breakaway.Process.Kill()
		breakaway.Wait()
		return errors.New("invocation job allowed CREATE_BREAKAWAY_FROM_JOB")
	} else if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		return fmt.Errorf("breakaway failed for an unrelated reason: %w", err)
	}
	record, err := jobGateIdentity()
	if err != nil {
		return err
	}
	record.ChildPID = descendant.PID
	if err = jobGateWrite(directory, "authorized", record); err != nil {
		return err
	}
	terminal := "finish"
	if mode == "retire-worker" {
		terminal = "retire"
	}
	_, err = jobGateRead(directory, terminal, jobGateLifetime)
	return err
}

func jobGateCoordinator(executable, directory, nonce, mode string) error {
	if _, err := jobGateRead(directory, "begin", jobGateWait); err != nil {
		return err
	}
	owned, err := newUpdateJob(nonce)
	if err != nil {
		return err
	}
	defer owned.Close()
	worker, err := startWorker(executable, jobGateArguments("worker", directory, nonce, mode), mode == "elevated")
	if err != nil {
		return err
	}
	defer worker.Close()
	record, err := jobGateRead(directory, "authorized", jobGateUACWait)
	if err != nil {
		return err
	}
	job := owned.(*windowsJob).handle
	for _, pid := range []uint32{record.PID, record.ChildPID} {
		process, err := syscall.OpenProcess(jobGateLimitedQuery, false, pid)
		if err != nil {
			return err
		}
		err = jobGateContains(job, process)
		syscall.CloseHandle(process)
		if err != nil {
			return err
		}
	}
	if err = jobGateWrite(directory, "ready", record); err != nil {
		return err
	}
	if _, err = jobGateRead(directory, "terminate", jobGateLifetime); err != nil {
		return err
	}
	var failure *UpdateRecoveryError
	if mode == "retire-worker" {
		if err = jobGateWrite(directory, "retire", jobGateRecord{}); err != nil {
			return err
		}
		if _, err = worker.Wait(jobGateWait); err != nil {
			return err
		}
		if err = owned.Wait(0); err == nil {
			return errors.New("descendant exited before its operation deadline")
		}
		failure = drainUpdate(worker, owned, time.Now())
	} else {
		failure = interruptUpdate(worker, owned, errors.New("native update timeout"), jobGateWait)
	}
	if failure == nil {
		return errors.New("forced descendant termination incorrectly allowed normal restart")
	}
	if !failure.ProcessesExited {
		return failure
	}
	return jobGateWrite(directory, "terminated", record)
}

func TestUpdaterJobOwnershipProcess(test *testing.T) {
	marker := slices.Index(os.Args, jobGateMarker)
	if marker < 0 {
		return
	}
	if len(os.Args[marker+1:]) != 4 {
		test.Fatal("invalid job gate subprocess arguments")
	}
	role, directory, nonce, mode := os.Args[marker+1], os.Args[marker+2], os.Args[marker+3], os.Args[marker+4]
	timer := time.AfterFunc(jobGateLifetime, func() { os.Exit(3) })
	defer timer.Stop()
	executable, err := os.Executable()
	if err == nil {
		switch role {
		case "coordinator":
			err = jobGateCoordinator(executable, directory, nonce, mode)
		case "worker":
			err = jobGateWorker(executable, directory, nonce, mode)
		case "descendant":
			var handle, process syscall.Handle
			handle, err = jobGateOpen(nonce, jobGateQuery)
			if err == nil {
				process, err = syscall.GetCurrentProcess()
				if err == nil {
					err = jobGateContains(handle, process)
				}
				err = errors.Join(err, syscall.CloseHandle(handle))
			}
			if err == nil {
				err = jobGateWrite(directory, "descendant", jobGateRecord{PID: uint32(os.Getpid())})
			}
			if err == nil {
				_, err = jobGateRead(directory, "finish", jobGateLifetime)
			}
		default:
			err = errors.New("unknown job gate subprocess role")
		}
	}
	if err != nil {
		jobGateWrite(directory, "failure-"+role, err.Error())
		test.Fatal(err)
	}
}

func testUpdaterJobOwnership(test *testing.T, nested, terminate, elevate, retireWorker bool) {
	test.Helper()
	identity, err := jobGateIdentity()
	if err != nil {
		test.Fatal(err)
	}
	if elevate && identity.Elevated {
		test.Fatal("UAC gate requires an unelevated coordinator in the interactive user session")
	}
	directory := test.TempDir()
	var random [24]byte
	if _, err = rand.Read(random[:]); err != nil {
		test.Fatal(err)
	}
	nonce := hex.EncodeToString(random[:])
	executable, err := os.Executable()
	if err != nil {
		test.Fatal(err)
	}
	mode := "ordinary"
	if elevate {
		mode = "elevated"
	}
	if retireWorker {
		mode = "retire-worker"
	}
	coordinator := exec.Command(executable, jobGateArguments("coordinator", directory, nonce, mode)...)
	hideProcess(coordinator)
	if err = coordinator.Start(); err != nil {
		test.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- coordinator.Wait() }()
	joined := false
	test.Cleanup(func() {
		if handle, err := jobGateOpen(nonce, jobGateTerminate); err == nil {
			kernel.NewProc("TerminateJobObject").Call(uintptr(handle), 1)
			syscall.CloseHandle(handle)
		}
		if !joined {
			coordinator.Process.Kill()
			select {
			case <-finished:
			case <-time.After(jobGateWait):
				test.Error("job gate coordinator cleanup unconfirmed")
			}
		}
	})
	var outer updateJob
	if nested {
		outer, err = newUpdateJob(nonce + "-outer")
		if err != nil {
			test.Fatal(err)
		}
		defer outer.Close()
		process, err := syscall.OpenProcess(jobGateSetQuota|syscall.PROCESS_TERMINATE, false, uint32(coordinator.Process.Pid))
		if err != nil {
			test.Fatal(err)
		}
		err = jobGateAssign(outer.(*windowsJob).handle, process)
		syscall.CloseHandle(process)
		if err != nil {
			test.Fatalf("nested job admission failed: %v", err)
		}
	}
	if err = jobGateWrite(directory, "begin", jobGateRecord{}); err != nil {
		test.Fatal(err)
	}
	wait := jobGateWait
	if elevate {
		wait = jobGateUACWait
	}
	record, err := jobGateRead(directory, "ready", wait)
	if err != nil {
		test.Fatal(err)
	}
	if record.SID != identity.SID || record.Elevated != (elevate || identity.Elevated) {
		test.Fatalf("worker identity changed: coordinator=%+v worker=%+v", identity, record)
	}
	var processes []syscall.Handle
	for _, pid := range []uint32{record.PID, record.ChildPID} {
		process, err := syscall.OpenProcess(syscall.SYNCHRONIZE|jobGateLimitedQuery, false, pid)
		if err != nil {
			test.Fatal(err)
		}
		defer syscall.CloseHandle(process)
		processes = append(processes, process)
		if outer != nil {
			if err = jobGateContains(outer.(*windowsJob).handle, process); err != nil {
				test.Fatal(err)
			}
		}
	}
	if unlock, err := installationLock(directory); err == nil {
		unlock()
		test.Fatal("worker did not hold its installation lock before authorization")
	}
	if terminate {
		if err = jobGateWrite(directory, "terminate", jobGateRecord{}); err != nil {
			test.Fatal(err)
		}
	} else if err = coordinator.Process.Kill(); err != nil {
		test.Fatal(err)
	}
	select {
	case err = <-finished:
		joined = true
		if terminate && err != nil {
			test.Fatal(err)
		}
	case <-time.After(jobGateWait):
		test.Fatal("coordinator did not exit")
	}
	for _, process := range processes {
		value, err := syscall.WaitForSingleObject(process, uint32(jobGateWait/time.Millisecond))
		if err != nil || value != syscall.WAIT_OBJECT_0 {
			test.Fatalf("invocation process survived coordinator termination: wait=%d err=%v", value, err)
		}
	}
	unlock, err := installationLock(directory)
	if err != nil {
		test.Fatalf("installation lock survived confirmed worker exit: %v", err)
	}
	unlock()
	test.Logf("coordinator SID=%s elevated=%t worker=%d elevated=%t descendant=%d nested=%t terminate=%t retired-worker=%t", identity.SID, identity.Elevated, record.PID, record.Elevated, record.ChildPID, nested, terminate, retireWorker)
}

func TestUpdaterJobOwnership(test *testing.T) {
	for _, scenario := range []struct {
		name         string
		nested       bool
		terminate    bool
		retireWorker bool
	}{
		{name: "coordinator-exit"},
		{name: "explicit-termination", terminate: true},
		{name: "nested-job", nested: true},
		{name: "worker-exit-with-live-descendant", terminate: true, retireWorker: true},
	} {
		test.Run(scenario.name, func(test *testing.T) {
			testUpdaterJobOwnership(test, scenario.nested, scenario.terminate, false, scenario.retireWorker)
		})
	}
}

func TestUpdaterJobOwnershipUAC(test *testing.T) {
	if os.Getenv(jobGateUACEnvironment) != "1" {
		test.Skip("interactive same-user UAC gate not requested")
	}
	testUpdaterJobOwnership(test, false, false, true, false)
}

func TestUpdaterJobRejectsLaunchBeforeAdmission(t *testing.T) {
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(random[:])
	job, err := newUpdateJob(nonce)
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	invocation, err := openUpdaterJob(nonce)
	if err != nil {
		t.Fatal(err)
	}
	defer invocation.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = invocation.Run(executable, []string{"-test.run=^TestUpdaterJobOwnershipProcess$"}); err == nil {
		t.Fatal("updater launched without worker admission")
	}
	if err = job.Wait(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err = openUpdaterJob(nonce + "missing"); err == nil {
		t.Fatal("accepted nonexistent job")
	}
}
