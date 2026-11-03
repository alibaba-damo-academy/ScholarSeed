package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestRemovalProcessHelper(t *testing.T) {
	if os.Getenv("SCHOLARSEED_REMOVAL_HELPER") != "1" {
		return
	}
	ready := os.Getenv("SCHOLARSEED_REMOVAL_READY")
	if err := os.WriteFile(ready, []byte("ready"), 0600); err != nil {
		os.Exit(2)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ready + ".exit"); err == nil {
			os.Exit(0)
		}
		time.Sleep(10 * time.Millisecond)
	}
	os.Exit(3)
}

func TestRemovalNativeProcessAndDelayedCleanup(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "旧版 app")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	updater := filepath.Join(root, "Update.exe")
	retire := removalExecutable(t, updater, data)
	ready := filepath.Join(parent, "ready")
	command := exec.Command(updater, "-test.run=^TestRemovalProcessHelper$")
	command.Env = append(os.Environ(), "SCHOLARSEED_REMOVAL_HELPER=1", "SCHOLARSEED_REMOVAL_READY="+ready)
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err = os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	state, err := inspectRemoval(root, "scholarseed")
	if err != nil || !state.active || !state.incomplete {
		t.Fatalf("live uninstall not detected: %+v %v", state, err)
	}
	other, err := inspectRemoval(filepath.Join(parent, "another-install"), "scholarseed")
	if err != nil || other.active {
		t.Fatalf("foreign installation matched: %+v %v", other, err)
	}
	if err = os.WriteFile(ready+".exit", nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err = command.Wait(); err != nil {
		t.Fatal(err)
	}
	state, err = inspectRemoval(root, "scholarseed")
	if err != nil || state.active || !state.incomplete {
		t.Fatalf("delayed cleanup not detected: %+v %v", state, err)
	}
	// Advance the real filesystem only after each observer poll. In particular,
	// an empty root must cause another poll before it is removed. No wall-clock
	// delay is needed to arrange either state.
	stage := 0
	var cleanupErr error
	err = waitRemoval(root, func() (removalState, error) {
		if cleanupErr != nil {
			return removalState{}, cleanupErr
		}
		return inspectRemoval(root, "scholarseed")
	}, time.Now, func(time.Duration) {
		switch stage {
		case 0:
			cleanupErr = retire()
		case 1:
			cleanupErr = os.Remove(root)
		default:
			cleanupErr = fmt.Errorf("unexpected removal poll after root deletion")
		}
		stage++
	})
	if stage != 2 && err == nil {
		t.Fatalf("observer skipped a cleanup state: %d", stage)
	}

	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("continued before root removal: %v", err)
	}
}

// Keep the real removal observer and timeout. A failed fixture deletion must
// interrupt polling with its underlying PathError, rather than hiding behind
// uninstall_incomplete two minutes later. Always join the cleanup goroutine.
func waitRemovalFixture(root string, cleaned <-chan error) error {
	pending := cleaned
	var cleanupErr error
	err := waitRemoval(root, func() (removalState, error) {
		select {
		case cleanupErr = <-pending:
			pending = nil
		default:
		}
		if cleanupErr != nil {
			return removalState{}, cleanupErr
		}
		return inspectRemoval(root, "scholarseed")
	}, time.Now, time.Sleep)
	// Joining cleanup must not make an early return from waitRemoval look valid.
	if err == nil {
		if _, statErr := os.Lstat(root); !errors.Is(statErr, os.ErrNotExist) {
			err = fmt.Errorf("removal observer returned before root disappeared: %s (stat=%v)", root, statErr)
		}
	}
	if pending != nil {
		cleanupErr = <-pending
	}
	if cleanupErr != nil {
		if errors.Is(err, cleanupErr) {
			err = nil
		}
		var code syscall.Errno
		errors.As(cleanupErr, &code)
		return errors.Join(err, fmt.Errorf("fixture cleanup failed (win32=%d): %w", code, cleanupErr))
	}
	return err
}

func TestRemovalFixtureReportsLockedFile(t *testing.T) {
	root := t.TempDir()
	updater := filepath.Join(root, "Update.exe")
	if err := os.WriteFile(updater, []byte("locked fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	// Exercise an actual Windows deletion failure without changing production
	// behavior or waiting for antivirus/process timing to reproduce it.
	handle, err := syscall.CreateFile(utf(updater), syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	cleaned := make(chan error, 1)
	go func() { cleaned <- os.Remove(updater) }()
	err = waitRemovalFixture(root, cleaned)
	var pathErr *os.PathError
	var code syscall.Errno
	if !errors.As(err, &pathErr) || pathErr.Path != updater || !errors.As(err, &code) || code == 0 {
		t.Fatalf("lost native deletion failure: %v", err)
	}
	t.Logf("observed native deletion failure: %v", err)
}

func TestRegisteredPartialRemovalDiagnostic(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Update.exe"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	var issue *directoryIssue
	if err := verifyRegisteredDirectory(root, "scholarseed"); !errors.As(err, &issue) || issue.Code != directoryUninstall {
		t.Fatalf("missing uninstall diagnostic: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "Update.exe")); err != nil {
		t.Fatal("preflight modified residue")
	}
}

// Reserve DELETE access at creation, before exposing the executable to external
// scanners. A later opener must share deletion. A separate writer is necessary:
// retaining write access would prevent Windows from loading the executable.
func removalExecutable(t *testing.T, path string, data []byte) func() error {
	t.Helper()
	const deleteAccess = 0x00010000
	const shareAll = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
	handle, err := syscall.CreateFile(utf(path), deleteAccess, shareAll, nil, syscall.CREATE_NEW, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			if err := syscall.CloseHandle(handle); err != nil {
				t.Errorf("close fixture lease: %v", err)
			}
		}
	})
	writer, err := syscall.CreateFile(utf(path), syscall.GENERIC_WRITE, shareAll, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(writer), path)
	_, writeErr := file.Write(data)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		t.Fatal(err)
	}
	return func() error {
		// POSIX disposition unlinks the name on closing our handle, even while a
		// compatible scanner retains a reader. Ordinary DeleteFile leaves a visible
		// DELETE_PENDING name and makes the observer fail with access denied.
		const fileDispositionInfoEx = 21
		const dispositionDelete = 1
		const dispositionPOSIX = 2
		flags := uint32(dispositionDelete | dispositionPOSIX)
		result, _, nativeErr := syscall.NewLazyDLL("kernel32.dll").NewProc("SetFileInformationByHandle").Call(uintptr(handle), fileDispositionInfoEx, uintptr(unsafe.Pointer(&flags)), unsafe.Sizeof(flags))
		if result == 0 {
			return fmt.Errorf("fixture cleanup failed (win32=%d): %w", nativeErr, &os.PathError{Op: "SetFileInformationByHandle", Path: path, Err: nativeErr})
		}
		err := syscall.CloseHandle(handle)
		closed = true
		if err != nil {
			return &os.PathError{Op: "CloseHandle", Path: path, Err: err}
		}
		return nil
	}
}

func TestRemovalExecutableOwnership(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "Update.exe")
	contents := []byte("owned fixture")
	retire := removalExecutable(t, path, contents)
	// A scanner cannot acquire a handle that vetoes deletion after creation.
	blocked, err := syscall.CreateFile(utf(path), syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, 0, 0)
	if err == nil {
		syscall.CloseHandle(blocked)
		t.Fatal("non-sharing reader acquired owned fixture")
	}
	const sharingViolation = syscall.Errno(32)
	if !errors.Is(err, sharingViolation) {
		t.Fatalf("unexpected sharing error: %v", err)
	}
	// A cooperative reader may stay open through unlinking and directory cleanup.
	reader, err := syscall.CreateFile(utf(path), syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(reader)
	if err := retire(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("fixture name remains: %v", err)
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(contents))
	var n uint32
	if err := syscall.ReadFile(reader, got, &n, nil); err != nil || string(got[:n]) != string(contents) {
		t.Fatalf("open reader lost data: %q %v", got[:n], err)
	}
}
