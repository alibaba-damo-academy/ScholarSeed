//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

func sandboxTestOrdinaryToken(t *testing.T, run func()) {
	t.Helper()
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	var token syscall.Token
	if err = syscall.OpenProcessToken(process, syscall.TOKEN_DUPLICATE|syscall.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	admins, err := syscall.StringToSid(sandboxAdminSID)
	if err != nil {
		t.Fatal(err)
	}
	disabled := syscall.SIDAndAttributes{Sid: admins}
	var restricted syscall.Token
	ok, _, callErr := security.NewProc("CreateRestrictedToken").Call(uintptr(token), 1, 1, uintptr(unsafe.Pointer(&disabled)), 0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
	if ok == 0 {
		t.Fatal(callErr)
	}
	defer restricted.Close()
	runtime.LockOSThread()
	ok, _, callErr = security.NewProc("ImpersonateLoggedOnUser").Call(uintptr(restricted))
	if ok == 0 {
		runtime.UnlockOSThread()
		t.Fatal(callErr)
	}
	defer func() {
		ok, _, err := security.NewProc("RevertToSelf").Call()
		if ok == 0 {
			t.Fatalf("restore thread token: %v", err)
		}
		runtime.UnlockOSThread()
	}()
	run()
}

func TestSandboxCredentialDeletionRecovery(t *testing.T) {
	process, _ := syscall.GetCurrentProcess()
	var token syscall.Token
	if err := syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	u, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	user, err := u.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	group := "S-1-5-21-1-2-3-1002"
	target := filepath.Join(t.TempDir(), sandboxSecrets)
	sandboxTestDirectory(t, target, "O:"+user+"D:P(D;OICI;0x1301bf;;;"+group+")(A;OICI;0x1201bf;;;"+user+")(A;OICI;0x1301bf;;;SY)(A;OICI;0x1301bf;;;BA)")
	fixture := filepath.Join(target, "non-secret.txt")
	if err := os.WriteFile(fixture, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	name, _ := syscall.UTF16PtrFromString(fixture)
	sandboxTestOrdinaryToken(t, func() {
		if err := syscall.DeleteFile(name); !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			t.Fatalf("baseline deletion must be denied: %v", err)
		}
		handle, err := sandboxOpen(target, toolReadControl)
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.CloseHandle(handle)
		before, err := sandboxSnapshot(handle)
		if err != nil {
			t.Fatal(err)
		}
		preparation, err := sandboxPreparation(target, before, user, false)
		if err != nil || preparation.Event != sandboxDeleteRequired {
			t.Fatalf("missing deletion must request repair: %+v %v", preparation, err)
		}
		raced := before
		raced.identity = "replaced-directory"
		if sandboxEnsureDeleteChild(target, raced, user, group) == nil {
			t.Fatal("identity drift accepted")
		}
		still, err := sandboxSnapshot(handle)
		if err != nil || still.fingerprint() != before.fingerprint() {
			t.Fatal("rejected repair changed security")
		}

		if err = sandboxEnsureDeleteChild(target, before, user, group); err != nil {
			got, _ := sandboxSnapshot(handle)
			t.Fatalf("%v before control=%x owner=%s ACL=%x after control=%x owner=%s ACL=%x", err, before.control, before.owner, before.acl, got.control, got.owner, got.acl)
		}
		if err = syscall.DeleteFile(name); err != nil {
			t.Fatalf("native DeleteFile must recover: %v", err)
		}
		after, err := sandboxSnapshot(handle)
		if err != nil {
			t.Fatal(err)
		}
		want, err := sandboxDeleteChildACL(before, user, group)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(after.acl, want) {
			t.Fatal("repair changed existing native ACEs")
		}
		if err = sandboxEnsureDeleteChild(target, after, user, group); err != nil {
			t.Fatal(err)
		}
		again, err := sandboxSnapshot(handle)
		if err != nil || again.fingerprint() != after.fingerprint() {
			t.Fatal("repair is not idempotent")
		}
		if err = sandboxEnsureSetupWriter(target, user, group, again.identity); err != nil {
			t.Fatal(err)
		}
		again, err = sandboxSnapshot(handle)
		if err != nil {
			t.Fatal(err)
		}
		preparation, err = sandboxPreparation(target, again, user, false)
		if err != nil || preparation.Event != sandboxUnchanged {
			t.Fatalf("repaired directory not usable: %+v %v", preparation, err)
		}
	})
}

func TestSandboxCredentialDeletionRejectsUnreviewedSecurity(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	before := sandboxSecurity{owner: user, acl: sandboxTestACL(t, user, group)}
	want, err := sandboxDeleteChildACL(before, user, group)
	if err != nil {
		t.Fatal(err)
	}
	added := want[len(before.acl):]
	if added[0] != 0 || added[1] != 0 || binary.LittleEndian.Uint32(added[4:8]) != sandboxDeleteChild {
		t.Fatal("new ACE is not directory-only DELETE_CHILD")
	}
	for _, mutate := range []func(*sandboxSecurity){
		func(s *sandboxSecurity) { s.owner = sandboxAdminSID },
		func(s *sandboxSecurity) { s.owner = group },
		func(s *sandboxSecurity) { s.acl[toolACLHeaderBytes] = 0 },
		func(s *sandboxSecurity) {
			s.acl = sandboxTestAppendACE(t, s.acl, "S-1-1-0", 0, toolInheritChildren, toolReadExecute)
		},
		func(s *sandboxSecurity) { s.acl = append(s.acl, 0) },
	} {
		changed := before
		changed.acl = bytes.Clone(before.acl)
		mutate(&changed)
		if _, err := sandboxDeleteChildACL(changed, user, group); err == nil {
			t.Fatal("unsafe credential repair accepted")
		}
	}
}
