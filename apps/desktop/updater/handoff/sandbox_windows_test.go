//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

func sandboxTestACL(t *testing.T, user, group string) []byte {
	t.Helper()
	acl := make([]byte, toolACLHeaderBytes)
	acl[0] = 2
	for _, entry := range []struct {
		sid  string
		kind byte
		mask uint32
	}{
		{group, 1, sandboxDenyMask}, {user, 0, sandboxUserMask}, {sandboxSystemSID, 0, sandboxDenyMask}, {sandboxAdminSID, 0, sandboxDenyMask},
	} {
		sid, err := syscall.StringToSid(entry.sid)
		if err != nil {
			t.Fatal(err)
		}
		length, _, _ := security.NewProc("GetLengthSid").Call(uintptr(unsafe.Pointer(sid)))
		ace := make([]byte, toolACEHeaderBytes+int(length))
		ace[0], ace[1] = entry.kind, toolInheritChildren
		binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
		binary.LittleEndian.PutUint32(ace[4:8], entry.mask)
		copy(ace[8:], unsafe.Slice((*byte)(unsafe.Pointer(sid)), int(length)))
		acl = append(acl, ace...)
	}
	binary.LittleEndian.PutUint16(acl[2:4], uint16(len(acl)))
	binary.LittleEndian.PutUint16(acl[4:6], 4)
	return acl
}

func TestSandboxRecoveryACLRequiresNativeDenyAndTrustedOwner(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	acl := sandboxTestACL(t, user, group)
	snapshot := sandboxSecurity{owner: sandboxAdminSID, acl: acl}
	if err := validateSandboxACL(snapshot, user, group, sandboxRepairACL); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*sandboxSecurity){
		func(s *sandboxSecurity) { s.owner = group },
		func(s *sandboxSecurity) { s.acl[toolACLHeaderBytes] = 0 },
		func(s *sandboxSecurity) { s.acl[toolACLHeaderBytes+1] = toolInheritOnly },
		func(s *sandboxSecurity) { s.acl[toolACLHeaderBytes] = 5 },
		func(s *sandboxSecurity) { binary.LittleEndian.PutUint32(s.acl[toolACLHeaderBytes+4:], toolReadExecute) },
	} {
		changed := snapshot
		changed.acl = bytes.Clone(acl)
		mutate(&changed)
		if validateSandboxACL(changed, user, group, sandboxRepairACL) == nil {
			t.Fatal("unsafe recovery ACL accepted")
		}
	}
}

func sandboxTestAppendACE(t *testing.T, acl []byte, principal string, kind, flags byte, mask uint32) []byte {
	t.Helper()
	sid, err := syscall.StringToSid(principal)
	if err != nil {
		t.Fatal(err)
	}
	ace := make([]byte, toolACEHeaderBytes+sid.Len())
	ace[0], ace[1] = kind, flags
	binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
	binary.LittleEndian.PutUint32(ace[4:8], mask)
	copy(ace[toolACEHeaderBytes:], unsafe.Slice((*byte)(unsafe.Pointer(sid)), sid.Len()))
	result := append(bytes.Clone(acl), ace...)
	binary.LittleEndian.PutUint16(result[2:4], uint16(len(result)))
	binary.LittleEndian.PutUint16(result[4:6], binary.LittleEndian.Uint16(acl[4:6])+1)
	return result
}

func TestSandboxRecoveryAcceptsOnlyDeniedInheritedGroupRead(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	for _, entry := range []struct {
		principal string
		flags     byte
		mask      uint32
		valid     bool
	}{
		{group, toolInheritedACE, toolReadExecute, true},
		{group, toolInheritedACE | toolInheritChildren, toolReadExecute, true},
		{group, toolInheritChildren, toolReadExecute, false},
		{group, toolInheritedACE, toolReadExecute | toolWriteDACL, false},
		{group, toolInheritedACE, sandboxUserMask, false},
		{"S-1-1-0", toolInheritedACE, toolReadExecute, false},
	} {
		acl := sandboxTestAppendACE(t, sandboxTestACL(t, user, group), entry.principal, 0, entry.flags, entry.mask)
		snapshot := sandboxSecurity{owner: sandboxAdminSID, acl: acl}
		if err := validateSandboxACL(snapshot, user, group, sandboxRepairACL); (err == nil) != entry.valid {
			t.Fatalf("flags=%x mask=%x principal=%s: %v", entry.flags, entry.mask, entry.principal, err)
		}
	}
	for _, flags := range []byte{0, toolInheritOnly, toolInheritedACE | toolInheritChildren, 1, 2, toolInheritChildren | 4} {
		acl := sandboxTestAppendACE(t, sandboxTestACL(t, user, group), group, 0, toolInheritedACE|toolInheritChildren, toolReadExecute)
		acl[toolACLHeaderBytes+1] = flags
		if validateSandboxACL(sandboxSecurity{owner: sandboxAdminSID, acl: acl}, user, group, sandboxRepairACL) == nil {
			t.Fatalf("incomplete or inherited deny accepted: %x", flags)
		}
	}
	acl := sandboxTestAppendACE(t, sandboxTestACL(t, user, group), group, 0, toolInheritedACE, toolReadExecute)
	denySize := int(binary.LittleEndian.Uint16(acl[toolACLHeaderBytes+2:]))
	deny := bytes.Clone(acl[toolACLHeaderBytes : toolACLHeaderBytes+denySize])
	copy(acl[toolACLHeaderBytes:], acl[toolACLHeaderBytes+denySize:])
	copy(acl[len(acl)-denySize:], deny)
	if validateSandboxACL(sandboxSecurity{owner: sandboxAdminSID, acl: acl}, user, group, sandboxRepairACL) == nil {
		t.Fatal("allow preceding native deny accepted")
	}
}

func TestSandboxRecoveryAncestorAllowsOnlyActualGroupRead(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	base := sandboxTestACL(t, user, group)
	denySize := int(binary.LittleEndian.Uint16(base[toolACLHeaderBytes+2:]))
	base = append(bytes.Clone(base[:toolACLHeaderBytes]), base[toolACLHeaderBytes+denySize:]...)
	binary.LittleEndian.PutUint16(base[2:4], uint16(len(base)))
	binary.LittleEndian.PutUint16(base[4:6], 3)
	for _, mask := range []uint32{toolReadExecute, toolReadExecute | 2, toolReadExecute | 4, toolReadExecute | 0x40, toolReadExecute | 0x10000, toolReadExecute | toolWriteDACL, toolReadExecute | sandboxWriteOwner} {
		acl := sandboxTestAppendACE(t, base, group, 0, toolInheritChildren, mask)
		snapshot := sandboxSecurity{owner: user, acl: acl}
		if err := validateSandboxACL(snapshot, user, group, sandboxAncestorACL); (err == nil) != (mask == toolReadExecute) {
			t.Fatalf("ancestor group mask=%x: %v", mask, err)
		}
		if validateSandboxACL(snapshot, user, "S-1-5-21-1-2-3-1003", sandboxAncestorACL) == nil {
			t.Fatal("different sandbox group accepted")
		}
	}
}

func TestSandboxPreparationDoesNotAuditUnrelatedACLs(t *testing.T) {
	parent, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	token, user, _, err := sandboxToken(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	ancestor := filepath.Join(t.TempDir(), "home")
	sandboxTestDirectory(t, ancestor, "O:"+user+"D:P(A;OICI;FA;;;"+user+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;WD)")
	ancestorHandle, err := sandboxOpen(ancestor, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(ancestorHandle)
	ancestorSecurity, err := sandboxSnapshot(ancestorHandle)
	if err != nil {
		t.Fatal(err)
	}
	if validateSandboxACL(ancestorSecurity, user, "", sandboxAncestorACL) == nil {
		t.Fatal("fixture did not exercise the old ancestor ACL rejection")
	}
	target := filepath.Join(ancestor, sandboxSecrets)
	if created, err := createSandboxDirectory(target, user); err != nil || !created {
		t.Fatalf("create private target: created=%v: %v", created, err)
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
	result, err := sandboxPreparation(target, before, user, false)
	if err != nil || result.Event != sandboxUnchanged {
		t.Fatalf("normal owner was blocked: %+v: %v", result, err)
	}
	after, err := sandboxSnapshot(handle)
	if err != nil || before.fingerprint() != after.fingerprint() {
		t.Fatalf("normal startup modified directory security: %v", err)
	}
	prepared, err := sandboxPreparation(target, before, user, true)
	if err != nil || prepared.Event != sandboxPrepared {
		t.Fatalf("private new target was blocked: %+v: %v", prepared, err)
	}
	unreviewed := before
	unreviewed.acl = sandboxTestAppendACE(t, before.acl, "S-1-1-0", 0, toolInheritChildren, toolReadExecute)
	if _, err = sandboxPreparation(target, unreviewed, user, true); err == nil {
		t.Fatal("an invalid newly-created descriptor was delegated")
	}
	administrative := before
	administrative.owner = sandboxAdminSID
	result, err = sandboxPreparation(target, administrative, user, false)
	if err != nil || result.Event != sandboxRepairRequired {
		t.Fatalf("temporary write access hid administrative ownership: %+v: %v", result, err)
	}
	denied := filepath.Join(t.TempDir(), sandboxSecrets)
	sandboxTestDirectory(t, denied, "O:"+user+"D:P(D;;WD;;;OW)(A;OICI;FA;;;"+user+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	deniedProbe, deniedErr := sandboxOpen(denied, toolReadControl|toolWriteDACL)
	if deniedErr == nil {
		syscall.CloseHandle(deniedProbe)
	}
	if deniedErr != nil && deniedErr != syscall.ERROR_ACCESS_DENIED {
		t.Fatalf("probe owner maintenance: %v", deniedErr)
	}
	deniedHandle, err := sandboxOpen(denied, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(deniedHandle)
	deniedBefore, err := sandboxSnapshot(deniedHandle)
	if err != nil {
		t.Fatal(err)
	}
	// Backup/restore privileges can make WRITE_DAC available despite OWNER RIGHTS
	// deny. Normal startup follows actual access under the original token.
	expected := sandboxUnsupported
	if deniedErr == nil {
		expected = sandboxUnchanged
	}
	result, err = sandboxPreparation(denied, deniedBefore, user, false)
	if err != nil || result.Event != expected {
		t.Fatalf("actual owner maintenance was not respected: %+v: %v (want %s)", result, err, expected)
	}
	// Retain real access-denied coverage even under an SSH Administrator token.
	sandboxTestWithoutPrivileges(t, func() {
		probe, accessErr := sandboxOpen(denied, toolReadControl|toolWriteDACL)
		if accessErr == nil {
			syscall.CloseHandle(probe)
		}
		if accessErr != syscall.ERROR_ACCESS_DENIED {
			t.Fatalf("restricted fixture did not deny owner maintenance: %v", accessErr)
		}
		result, err := sandboxPreparation(denied, deniedBefore, user, false)
		if err != nil || result.Event != sandboxUnsupported {
			t.Fatalf("non-owner-maintenance policy was not delegated: %+v: %v", result, err)
		}
		if _, err = sandboxPreparation(denied, deniedBefore, user, true); err == nil {
			t.Fatal("inaccessible newly-created directory was delegated")
		}
	})
	deniedAfter, err := sandboxSnapshot(deniedHandle)
	if err != nil || deniedBefore.fingerprint() != deniedAfter.fingerprint() {
		t.Fatalf("delegation modified directory security: %v", err)
	}
}

func TestSandboxProfileCapabilityTraversalDoesNotAuthorizeSecrets(t *testing.T) {
	user := "S-1-5-21-1-2-3-1008"
	capability := "S-1-15-3-65536-599108337-235189375-1353122160-3480128286-3345335107-485756383-4087318168-230526575"
	for _, principal := range []string{capability, "S-1-1-0"} {
		for _, entry := range []struct {
			flags string
			mask  string
			valid bool
		}{
			{"", "0x100020", true},
			{"ID", "0x100020", true},
			{"", "0x100021", false},
			{"", "0x100022", false},
			{"", "0x40000", false},
			{"", "0x80000", false},
			{"OI", "0x100020", false},
			{"CI", "0x100020", false},
		} {
			sddl := "O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + user + ")(A;" + entry.flags + ";" + entry.mask + ";;;" + principal + ")"
			encoded, err := syscall.UTF16PtrFromString(sddl)
			if err != nil {
				t.Fatal(err)
			}
			var descriptor unsafe.Pointer
			ok, _, callErr := security.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(encoded)), toolDescriptorRevision, uintptr(unsafe.Pointer(&descriptor)), 0)
			if ok == 0 {
				t.Fatal(callErr)
			}
			var acl unsafe.Pointer
			var present, defaulted uint32
			ok, _, callErr = security.NewProc("GetSecurityDescriptorDacl").Call(uintptr(descriptor), uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&acl)), uintptr(unsafe.Pointer(&defaulted)))
			if ok == 0 || present == 0 || acl == nil {
				kernel.NewProc("LocalFree").Call(uintptr(descriptor))
				t.Fatal(callErr)
			}
			size := binary.LittleEndian.Uint16(unsafe.Slice((*byte)(acl), toolACLHeaderBytes)[2:4])
			snapshot := sandboxSecurity{owner: sandboxSystemSID, acl: bytes.Clone(unsafe.Slice((*byte)(acl), int(size)))}
			kernel.NewProc("LocalFree").Call(uintptr(descriptor))
			err = validateSandboxACL(snapshot, user, "", sandboxAncestorACL)
			if (err == nil) != entry.valid {
				t.Fatalf("ancestor ACL validity %v: %s: %v", entry.valid, sddl, err)
			}
			if validateSandboxACL(snapshot, user, "", sandboxPrivateACL) == nil {
				t.Fatal("ancestor traversal exception leaked into secrets policy")
			}
		}
	}
}

func TestSandboxSecretsRejectsUntrustedInheritOnlyGrants(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	acl := sandboxTestACL(t, user, group)
	sid, err := syscall.StringToSid("S-1-1-0")
	if err != nil {
		t.Fatal(err)
	}
	length, _, _ := security.NewProc("GetLengthSid").Call(uintptr(unsafe.Pointer(sid)))
	ace := make([]byte, toolACEHeaderBytes+int(length))
	ace[1] = toolInheritChildren | toolInheritOnly
	binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
	binary.LittleEndian.PutUint32(ace[4:8], toolFullAccess)
	copy(ace[8:], unsafe.Slice((*byte)(unsafe.Pointer(sid)), int(length)))
	acl = append(acl, ace...)
	binary.LittleEndian.PutUint16(acl[2:4], uint16(len(acl)))
	binary.LittleEndian.PutUint16(acl[4:6], 5)
	snapshot := sandboxSecurity{owner: sandboxAdminSID, acl: acl}
	for _, mode := range []sandboxACLMode{sandboxPrivateACL, sandboxRepairACL} {
		if validateSandboxACL(snapshot, user, group, mode) == nil {
			t.Fatal("untrusted child permission passed secrets validation")
		}
	}
}

func TestSandboxOwnerOnlyKeepsDACLAndIdentity(t *testing.T) {
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	var token syscall.Token
	if err = syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), sandboxSecrets)
	created, err := createSandboxDirectory(target, sid)
	if err != nil || !created {
		t.Fatalf("create: %v", err)
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
	if err = sandboxSetOwner(target, before, sid); err != nil {
		t.Fatal(err)
	}
	after, err := sandboxSnapshot(handle)
	if err != nil {
		t.Fatal(err)
	}
	if before.fingerprint() != after.fingerprint() {
		t.Fatal("owner no-op changed security")
	}
	other := before
	other.identity = "changed"
	if sandboxSetOwner(target, other, sid) == nil {
		t.Fatal("changed identity accepted")
	}
	if _, err = os.Stat(target); err != nil {
		t.Fatal(err)
	}
	nativeACL := sandboxTestACL(t, sid, "S-1-5-21-1-2-3-1002")
	writable, err := sandboxOpen(target, toolReadControl|toolWriteDACL)
	if err != nil {
		t.Fatal(err)
	}
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(writable), toolFileObject, toolDACLInformation|toolProtectedDACL, 0, 0, uintptr(unsafe.Pointer(&nativeACL[0])), 0)
	syscall.CloseHandle(writable)
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
	probe, err := sandboxOpen(target, toolReadControl|toolWriteDACL)
	if err != nil {
		t.Fatalf("user owner cannot maintain ACL after native-style DACL replacement: %v", err)
	}
	syscall.CloseHandle(probe)
}

// sandboxTestWithoutPrivileges preserves the account, groups and process token.
// Reverting before unlocking keeps the restricted token off unrelated Go work.
func sandboxTestWithoutPrivileges(t *testing.T, run func()) {
	t.Helper()
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	var token syscall.Token
	if err := syscall.OpenProcessToken(process, syscall.TOKEN_DUPLICATE|syscall.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	const disableMaxPrivilege = 1
	var restricted syscall.Token
	ok, _, callErr := security.NewProc("CreateRestrictedToken").Call(uintptr(token), disableMaxPrivilege, 0, 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
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
		ok, _, callErr := security.NewProc("RevertToSelf").Call()
		if ok == 0 {
			// Leave locked: Go destroys this thread when the test goroutine exits.
			t.Fatalf("restore test thread token: %v", callErr)
		}
		runtime.UnlockOSThread()
	}()
	run()
}

func sandboxTestDirectory(t *testing.T, target, sddl string) {
	t.Helper()
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor unsafe.Pointer
	ok, _, callErr := security.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(text)), toolDescriptorRevision, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		t.Fatal(callErr)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: uintptr(descriptor)}
	name, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		t.Fatal(err)
	}
	ok, _, callErr = kernel.NewProc("CreateDirectoryW").Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&attributes)))
	if ok == 0 {
		t.Fatal(callErr)
	}
}

func TestSandboxOwnerTransferAcceptsNativeOwnerRights(t *testing.T) {
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	var token syscall.Token
	if err = syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	for _, inherited := range []bool{false, true} {
		t.Run(fmt.Sprint(inherited), func(t *testing.T) {
			parent := filepath.Join(t.TempDir(), "parent")
			sandboxTestDirectory(t, parent, "O:"+sid+"D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
			target := filepath.Join(parent, sandboxSecrets)
			ownerRights := "(A;OICI;FA;;;OW)"
			if inherited {
				ownerRights = ""
			}
			sandboxTestDirectory(t, target, "O:BAD:P(D;OICI;0x1301bf;;;S-1-5-21-1-2-3-1002)(A;OICI;0x1201bf;;;"+sid+")(A;OICI;0x1301bf;;;SY)(A;OICI;0x1301bf;;;BA)"+ownerRights)
			if inherited {
				const unprotectedDACL = 0x20000000
				writable, err := sandboxOpen(target, toolReadControl|toolWriteDACL)
				if err != nil {
					t.Fatal(err)
				}
				initial, err := sandboxSnapshot(writable)
				if err != nil {
					syscall.CloseHandle(writable)
					t.Fatal(err)
				}
				status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(writable), toolFileObject, toolDACLInformation|unprotectedDACL, 0, 0, uintptr(unsafe.Pointer(&initial.acl[0])), 0)
				syscall.CloseHandle(writable)
				if status != 0 {
					t.Fatal(syscall.Errno(status))
				}
			}
			handle, err := sandboxOpen(target, toolReadControl)
			if err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(handle)
			before, err := sandboxSnapshot(handle)
			if err != nil || before.owner != sandboxAdminSID {
				t.Fatalf("fixture owner: %s: %v", before.owner, err)
			}
			if err = validateSandboxACL(before, sid, "S-1-5-21-1-2-3-1002", sandboxRepairACL); err != nil {
				t.Fatal(err)
			}
			if err = sandboxSetOwner(target, before, sid); err != nil {
				after, _ := sandboxSnapshot(handle)
				t.Fatalf("first owner recovery rejected: %v; owner=%s control=%x/%x acl=%x/%x", err, after.owner, before.control, after.control, before.acl, after.acl)
			}
			after, err := sandboxSnapshot(handle)
			if err != nil || after.owner != sid || after.identity != before.identity || after.control != before.control {
				t.Fatalf("owner recovery state: %+v: %v", after, err)
			}
			if !sandboxOwnerRestored(before, after, sid) {
				t.Fatal("coordinator rejected native owner recovery")
			}
			if bytes.Equal(before.acl, after.acl) {
				t.Fatal("fixture did not exercise Windows OWNER RIGHTS normalization")
			}
			if err = validateSandboxACL(after, sid, "S-1-5-21-1-2-3-1002", sandboxRepairACL); err != nil {
				t.Fatal(err)
			}
			probe, err := sandboxOpen(target, toolReadControl|toolWriteDACL)
			if err != nil {
				t.Fatal(err)
			}
			syscall.CloseHandle(probe)
			if event := sandboxPreparationEvent(after.owner, sid, true); event != sandboxUnchanged {
				t.Fatalf("healthy owner requested another recovery: %s", event)
			}
			repeated, err := sandboxSnapshot(handle)
			if err != nil || repeated.fingerprint() != after.fingerprint() {
				t.Fatalf("repeat recovery changed security state: %v", err)
			}
		})
	}
}

func TestSandboxOwnerVerificationRejectsUnrelatedChanges(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	ownerSID, err := syscall.StringToSid(sandboxOwnerSID)
	if err != nil {
		t.Fatal(err)
	}
	for _, inherited := range []byte{0, toolInheritedACE} {
		acl := sandboxTestACL(t, user, group)
		position := len(acl)
		ace := make([]byte, toolACEHeaderBytes+ownerSID.Len())
		ace[1] = toolInheritChildren | inherited
		binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
		binary.LittleEndian.PutUint32(ace[4:8], toolFullAccess)
		copy(ace[toolACEHeaderBytes:], unsafe.Slice((*byte)(unsafe.Pointer(ownerSID)), ownerSID.Len()))
		acl = append(acl, ace...)
		binary.LittleEndian.PutUint16(acl[2:4], uint16(len(acl)))
		binary.LittleEndian.PutUint16(acl[4:6], 5)
		before := sandboxSecurity{owner: sandboxAdminSID, acl: acl, control: 0x9004, identity: "pinned"}
		after := before
		after.owner, after.acl = user, bytes.Clone(acl)
		after.acl[position+1] = toolInheritOnly | inherited
		if !sandboxOwnerRestored(before, after, user) {
			t.Fatal("reviewed Windows OWNER RIGHTS transformation rejected")
		}
		for offset := range after.acl {
			for bit := byte(1); bit != 0; bit <<= 1 {
				changed := after
				changed.acl = bytes.Clone(after.acl)
				changed.acl[offset] ^= bit
				if sandboxOwnerRestored(before, changed, user) {
					t.Fatalf("unreviewed ACL mutation accepted at byte %d bit %x", offset, bit)
				}
			}
		}
		for _, mutate := range []func(*sandboxSecurity, *sandboxSecurity){
			func(original, changed *sandboxSecurity) { changed.owner = sandboxAdminSID },
			func(original, changed *sandboxSecurity) { changed.identity = "replaced" },
			func(original, changed *sandboxSecurity) { changed.control ^= toolProtectedDACL >> 16 },
			func(original, changed *sandboxSecurity) { original.owner = user },
			func(original, changed *sandboxSecurity) { original.owner = sandboxSystemSID },
			func(original, changed *sandboxSecurity) { changed.acl = changed.acl[:len(changed.acl)-1] },
			func(original, changed *sandboxSecurity) { original.acl = original.acl[:toolACLHeaderBytes-1] },
		} {
			original, changed := before, after
			mutate(&original, &changed)
			if sandboxOwnerRestored(original, changed, user) {
				t.Fatal("unreviewed security state change accepted")
			}
		}
		for _, flags := range []byte{0, toolInheritedACE, toolInheritOnly, toolInheritChildren | toolInheritOnly, toolInheritChildren | toolInheritOnly | toolInheritedACE} {
			if flags == after.acl[position+1] {
				continue
			}
			original := before
			original.acl = bytes.Clone(before.acl)
			original.acl[position+1] = flags
			if sandboxOwnerRestored(original, after, user) {
				t.Fatalf("unreviewed source OWNER RIGHTS flags accepted: %x", flags)
			}
		}
		for _, offset := range []int{position, position + 4, len(acl) - 1} {
			original, changed := before, after
			original.acl, changed.acl = bytes.Clone(before.acl), bytes.Clone(after.acl)
			original.acl[offset] ^= 1
			changed.acl[offset] ^= 1
			if sandboxOwnerRestored(original, changed, user) {
				t.Fatalf("normalization allowed for unreviewed OWNER RIGHTS ACE at %d", offset)
			}
		}
	}
}

// Run this test under both a normal user and an elevated profile user. The
// identity must remain that of the original coordinator in either case.
func TestSandboxCoordinatorIdentityPreservesOriginalToken(t *testing.T) {
	parent, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	var original syscall.Token
	if err = syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &original); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	originalUser, err := original.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	expectedSID, err := originalUser.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	var expectedProfile [32768]uint16
	length := uint32(len(expectedProfile))
	ok, _, callErr := syscall.NewLazyDLL("userenv.dll").NewProc("GetUserProfileDirectoryW").Call(uintptr(original), uintptr(unsafe.Pointer(&expectedProfile[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		t.Fatal(callErr)
	}
	token, sid, profile, err := sandboxToken(parent)
	if err != nil {
		t.Fatalf("original coordinator identity rejected: %v", err)
	}
	defer token.Close()
	returnedUser, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	returnedSID, err := returnedUser.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	if sid != expectedSID || returnedSID != expectedSID || profile != syscall.UTF16ToString(expectedProfile[:]) {
		t.Fatal("sandbox recovery substituted the original coordinator identity")
	}
}

func TestSandboxCoordinatorIdentityRequiresLiveProcess(t *testing.T) {
	var missing *windowsWaiter
	if _, _, _, err := sandboxToken(missing); err == nil {
		t.Fatal("missing coordinator accepted")
	}
	if _, _, _, err := sandboxToken(&windowsWaiter{}); err == nil {
		t.Fatal("invalid coordinator handle accepted")
	}
}
