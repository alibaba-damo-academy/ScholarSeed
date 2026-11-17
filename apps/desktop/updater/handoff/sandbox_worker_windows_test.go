//go:build windows

package handoff

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

func sandboxTestPrivilege(t *testing.T, name string, enabled bool) {
	t.Helper()
	p, _ := syscall.GetCurrentProcess()
	var token syscall.Token
	if err := syscall.OpenProcessToken(p, syscall.TOKEN_QUERY|sandboxTokenAdjust, &token); err != nil {
		t.Fatal(err)
	}

	wide, _ := syscall.UTF16PtrFromString(name)
	var privilege struct {
		Count, Low uint32
		High       int32
		Attributes uint32
	}
	privilege.Count = 1
	if enabled {
		privilege.Attributes = 2
	}
	ok, _, e := security.NewProc("LookupPrivilegeValueW").Call(0, uintptr(unsafe.Pointer(wide)), uintptr(unsafe.Pointer(&privilege.Low)))
	if ok == 0 {
		token.Close()
		t.Fatal(e)
	}
	previous := privilege
	var returned uint32
	kernel.NewProc("SetLastError").Call(0)
	ok, _, e = security.NewProc("AdjustTokenPrivileges").Call(uintptr(token), 0, uintptr(unsafe.Pointer(&privilege)), unsafe.Sizeof(previous), uintptr(unsafe.Pointer(&previous)), uintptr(unsafe.Pointer(&returned)))
	if previous.Count == 0 {
		previous = privilege
	}
	t.Cleanup(func() {
		defer token.Close()
		ok, _, restoreErr := security.NewProc("AdjustTokenPrivileges").Call(uintptr(token), 0, uintptr(unsafe.Pointer(&previous)), 0, 0, 0)
		if ok == 0 {
			t.Error(restoreErr)
		}
	})
	if ok == 0 || e == sandboxPrivilegeMissing {
		t.Fatal(e)
	}
}

func TestSandboxCrossUserBinWorkerReadsPrivateAncestors(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	product := filepath.Join(profile, ".scholarseed")
	home := filepath.Join(product, "codex")
	target := filepath.Join(home, ".sandbox-bin")
	user := "S-1-5-21-1-2-3-1001"
	sandboxTestPrivilege(t, "SeRestorePrivilege", true)
	defer func() {
		sandboxTestPrivilege(t, "SeRestorePrivilege", true)
		sandboxTestPrivilege(t, "SeBackupPrivilege", true)
		h, err := sandboxOpen(home, toolReadControl|toolWriteDACL)
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.CloseHandle(h)
		snapshot, err := sandboxSnapshot(h)
		if err != nil {
			t.Fatal(err)
		}
		acl, err := sandboxAppendDirectoryGrant(snapshot.acl, sandboxAdminSID, toolFullAccess)
		if err != nil {
			t.Fatal(err)
		}
		status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(h), toolFileObject, toolDACLInformation, 0, 0, uintptr(unsafe.Pointer(&acl[0])), 0)
		if status != 0 {
			t.Fatal(syscall.Errno(status))
		}
	}()
	for _, p := range []string{profile, product} {
		sandboxTestDirectory(t, p, "O:BAD:P(A;OICI;FA;;;"+user+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	}
	sandboxTestDirectory(t, home, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)")
	sandboxTestDirectory(t, target, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)(A;;FA;;;BA)")
	h, err := sandboxOpen(target, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	before, err := sandboxSnapshot(h)
	syscall.CloseHandle(h)
	if err != nil {
		t.Fatal(err)
	}
	sandboxTestPrivilege(t, "SeRestorePrivilege", false)
	sandboxTestPrivilege(t, "SeBackupPrivilege", false)
	if probe, openErr := sandboxOpen(home, toolReadControl); !errors.Is(openErr, syscall.ERROR_ACCESS_DENIED) {
		if openErr == nil {
			syscall.CloseHandle(probe)
		}
		t.Fatalf("fixture must deny cross-user metadata read: %v", openErr)
	}
	parent, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	if err := sandboxBinOwnerWorker(home, user, "", "stale", parent); err == nil {
		t.Fatal("worker accepted a stale security snapshot")
	}
	h, err = sandboxOpen(target, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	rejected, err := sandboxSnapshot(h)
	syscall.CloseHandle(h)
	if err != nil || rejected.fingerprint() != before.fingerprint() {
		t.Fatal("rejected worker changed target security")
	}
	err = sandboxBinOwnerWorker(home, user, "", before.fingerprint(), parent)
	if err != nil {
		t.Fatalf("cross-user worker failed (access denied=%v): %v", errors.Is(err, syscall.ERROR_ACCESS_DENIED), err)
	}
	h, err = sandboxOpen(target, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	after, err := sandboxSnapshot(h)
	if err != nil {
		t.Fatal(err)
	}
	if !sandboxOwnerRestored(before, after, sandboxAdminSID) {
		t.Fatal("worker changed more than bin ownership")
	}
}
