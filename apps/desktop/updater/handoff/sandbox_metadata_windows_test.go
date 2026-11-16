//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

func TestSandboxMetadataOwnerRights(t *testing.T) {
	user, group := "S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1002"
	for _, directory := range []bool{true, false} {
		for _, entry := range []struct {
			name        string
			owner       string
			ownerMask   uint32
			groupMask   uint32
			foreign     bool
			inheritOnly bool
			valid       bool
		}{
			{"original user", user, toolFullAccess, sandboxDenyMask, false, false, true},
			{"administrators", sandboxAdminSID, toolFullAccess, sandboxDenyMask, false, false, true},
			{"system", sandboxSystemSID, toolFullAccess, sandboxDenyMask, false, false, true},
			{"untrusted owner", group, toolFullAccess, sandboxDenyMask, false, false, false},
			{"partial owner rights", user, toolReadExecute, sandboxDenyMask, false, false, false},
			{"excess native group rights", user, toolFullAccess, toolFullAccess, false, false, false},
			{"foreign writer", user, toolFullAccess, sandboxDenyMask, true, false, false},
			{"inherit-only owner rights", user, toolFullAccess, sandboxDenyMask, false, true, true},
			{"partial inherit-only owner rights", user, toolReadExecute, sandboxDenyMask, false, true, false},
			{"untrusted inherit-only owner", group, toolFullAccess, sandboxDenyMask, false, true, false},
		} {
			t.Run(fmt.Sprintf("%s/directory=%t", entry.name, directory), func(t *testing.T) {
				acl := make([]byte, toolACLHeaderBytes)
				acl[0] = 2
				binary.LittleEndian.PutUint16(acl[2:4], uint16(len(acl)))
				ownerFlags := byte(toolInheritChildren | toolInheritedACE)
				if entry.inheritOnly {
					ownerFlags = toolInheritOnly | toolInheritedACE
				}
				for _, grant := range []struct {
					principal string
					flags     byte
					mask      uint32
				}{
					{sandboxSystemSID, toolInheritChildren, sandboxDenyMask},
					{sandboxAdminSID, toolInheritChildren, sandboxDenyMask},
					{user, toolInheritChildren, sandboxUserMask},
					{group, toolInheritChildren, entry.groupMask},
					{sandboxSystemSID, toolInheritChildren | toolInheritedACE, toolFullAccess},
					{sandboxAdminSID, toolInheritChildren | toolInheritedACE, toolFullAccess},
					{sandboxOwnerSID, ownerFlags, entry.ownerMask},
				} {
					acl = sandboxTestAppendACE(t, acl, grant.principal, 0, grant.flags, grant.mask)
				}
				if entry.foreign {
					acl = sandboxTestAppendACE(t, acl, "S-1-5-21-1-2-3-1003", 0, toolInheritedACE, sandboxDenyMask)
				}
				before := sandboxSecurity{owner: entry.owner, acl: acl}
				original := bytes.Clone(acl)
				result, err := sandboxMetadataACL(before, user, group, directory)
				if (err == nil) != entry.valid {
					t.Fatalf("valid=%t: %v", entry.valid, err)
				}
				if !bytes.Equal(before.acl, original) {
					t.Fatal("input ACL was modified")
				}
				if entry.valid && !bytes.Equal(result, original) {
					t.Fatal("sufficient existing maintenance ACL was changed")
				}
			})
		}
	}
}

func metadataTestUser(t *testing.T) string {
	t.Helper()
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
	return user
}

func TestSandboxMetadataMaintenance(t *testing.T) {
	user := metadataTestUser(t)
	group := "S-1-5-21-1-2-3-1002"
	target := filepath.Join(t.TempDir(), sandboxMetadata)
	sandboxTestDirectory(t, target, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)")
	untouched := filepath.Join(target, "unrelated")
	sandboxTestDirectory(t, untouched, "O:"+user+"D:(A;;FA;;;"+user+")(A;;FA;;;SY)")
	child, err := sandboxOpen(untouched, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(child)
	childBefore, err := sandboxSnapshot(child)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := sandboxOpen(target, sandboxMaximumAllowed)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	before, err := sandboxSnapshot(handle)
	if err != nil {
		t.Fatal(err)
	}
	acl, err := sandboxMetadataACL(before, user, group, true)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(acl, before.acl) {
		t.Fatal("missing administrators maintenance was not repaired")
	}
	if err = sandboxMetadataWrite(handle, before, acl, true); err != nil {
		t.Fatal(err)
	}
	after, err := sandboxSnapshot(handle)
	if err != nil {
		t.Fatal(err)
	}
	second, err := sandboxMetadataACL(after, user, group, true)
	if err != nil || !bytes.Equal(second, after.acl) {
		t.Fatalf("not idempotent: %v", err)
	}
	childAfter, err := sandboxSnapshot(child)
	if err != nil || childAfter.fingerprint() != childBefore.fingerprint() {
		t.Fatalf("unrelated descendant changed: %v; before=%+v after=%+v", err, childBefore, childAfter)
	}
	if err = sandboxMetadataWrite(handle, before, acl, true); err == nil {
		t.Fatal("stale snapshot accepted")
	}
}

func TestSandboxMetadataRejectsUnsafePolicy(t *testing.T) {
	// Backup semantics let this test inspect intentionally unreadable policy
	// without depending on the host's ambient privileges or widening its ACL.
	sandboxTestPrivilege(t, "SeBackupPrivilege", true)
	user := metadataTestUser(t)
	denyUser := "(D;;FW;;;" + user + ")"
	for _, extra := range []string{"(A;OICIIO;FA;;;WD)", "(A;;FR;;;WD)", "(A;;FA;;;S-1-5-21-1-2-3-1002)", "(D;;FW;;;BA)", denyUser} {
		t.Run(extra, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), sandboxMetadata)
			sandboxTestDirectory(t, target, "O:"+user+"D:P"+extra+"(A;;FA;;;"+user+")(A;;FA;;;SY)")
			h, err := sandboxOpen(target, toolReadControl)
			if err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(h)
			before, err := sandboxSnapshot(h)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = sandboxMetadataACL(before, user, "S-1-5-21-1-2-3-1002", true); err == nil {
				t.Fatal("unsafe policy accepted")
			}
			if extra == denyUser {
				sandboxTestWithoutPrivileges(t, func() {
					probe, openErr := sandboxOpen(target, toolReadControl)
					if openErr == nil {
						syscall.CloseHandle(probe)
					}
					if !errors.Is(openErr, syscall.ERROR_ACCESS_DENIED) {
						t.Fatalf("deny fixture did not reject unprivileged read: %v", openErr)
					}
				})
			}
			after, err := sandboxSnapshot(h)
			if err != nil || after.fingerprint() != before.fingerprint() {
				t.Fatalf("rejected policy changed: %v", err)
			}
		})
	}
}

func TestSandboxMetadataFileRejectsHardlink(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sandbox.2026-11-10.log")
	if err := os.WriteFile(file, []byte("nonsecret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(file, filepath.Join(root, "other")); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err = sandboxObjectSnapshot(syscall.Handle(f.Fd()), false); err == nil {
		t.Fatal("hardlink accepted")
	}
}

func TestSandboxMetadataLogNames(t *testing.T) {
	for _, name := range []string{"sandbox.2026-11-10.log", "sandbox.2024-02-29.log"} {
		if !sandboxMetadataLog(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"sandbox_users.json", "sandbox.2026-02-30.log", "sandbox.2026-1-1.log", "sandbox.2026-11-10.log:stream", "../sandbox.2026-11-10.log"} {
		if sandboxMetadataLog(name) {
			t.Fatal(name)
		}
	}
}

// Logs created under the native user's restrictive parent retain their contents
// and identity when the elevated setup writer's access is restored.
func TestSandboxMetadataExistingLog(t *testing.T) {
	user := metadataTestUser(t)
	root := filepath.Join(t.TempDir(), "logs")
	sandboxTestDirectory(t, root, "O:"+user+"D:P(A;OICI;FA;;;"+user+")(A;OICI;FA;;;SY)")
	name := filepath.Join(root, "sandbox.2026-11-10.log")
	content := []byte("non-secret log fixture\n")
	if err := os.WriteFile(name, content, 0600); err != nil {
		t.Fatal(err)
	}
	path, _ := syscall.UTF16PtrFromString(name)
	h, err := syscall.CreateFile(path, sandboxMaximumAllowed, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	// Elevated test tokens default to Administrators ownership; reproduce the
	// original ordinary user's ownership explicitly, without changing the DACL.
	sid, err := syscall.StringToSid(user)
	if err != nil {
		t.Fatal(err)
	}
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(h), toolFileObject, 1, uintptr(unsafe.Pointer(sid)), 0, 0, 0)
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
	before, err := sandboxObjectSnapshot(h, false)
	if err != nil {
		t.Fatal(err)
	}
	acl, err := sandboxMetadataACL(before, user, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(before.acl, acl) {
		t.Fatal("fixture already grants administrator access")
	}
	if err = sandboxMetadataWrite(h, before, acl, false); err != nil {
		t.Fatal(err)
	}
	after, err := sandboxObjectSnapshot(h, false)
	if err != nil {
		t.Fatal(err)
	}
	again, err := sandboxMetadataACL(after, user, "", false)
	if err != nil || !bytes.Equal(after.acl, again) {
		t.Fatalf("log repair not idempotent: %v", err)
	}
	syscall.CloseHandle(h)
	got, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(content, got) {
		t.Fatalf("log contents changed: %v", err)
	}
}

func TestSandboxMetadataPreparation(t *testing.T) {
	user := metadataTestUser(t)
	profile := filepath.Join(t.TempDir(), "profile")
	product := filepath.Join(profile, ".scholarseed")
	home := filepath.Join(product, "codex")
	target := filepath.Join(home, sandboxMetadata)
	for _, dir := range []string{profile, product, home, target} {
		sandboxTestDirectory(t, dir, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)")
	}
	if err := sandboxPrepareMetadata(home, user, ""); err != nil {
		t.Fatal(err)
	}
	if err := sandboxPrepareMetadata(home, user, ""); err != nil {
		t.Fatalf("second preparation: %v", err)
	}
}

func TestSandboxBinRejectsGroupWrite(t *testing.T) {
	user := metadataTestUser(t)
	group := "S-1-5-21-1-2-3-1002"
	home := t.TempDir()
	target := filepath.Join(home, ".sandbox-bin")
	sandboxTestDirectory(t, target, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)(A;;0x1301bf;;;"+group+")")
	if err := sandboxPrepareBin(home, user, group); err == nil {
		t.Fatal("writable native bin group accepted")
	}
}

func TestSandboxBinExistingDirectory(t *testing.T) {
	user := metadataTestUser(t)
	home := t.TempDir()
	target := filepath.Join(home, ".sandbox-bin")
	sandboxTestDirectory(t, target, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)")
	child := filepath.Join(target, "untouched")
	sandboxTestDirectory(t, child, "O:"+user+"D:(A;;FA;;;"+user+")(A;;FA;;;SY)")
	h, err := sandboxOpen(child, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	before, err := sandboxSnapshot(h)
	if err != nil {
		t.Fatal(err)
	}
	if err = sandboxPrepareBin(home, user, ""); err != nil {
		t.Fatal(err)
	}
	after, err := sandboxSnapshot(h)
	if err != nil || before.fingerprint() != after.fingerprint() {
		t.Fatalf("binary descendant changed: %v", err)
	}
	if err = sandboxPrepareBin(home, user, ""); err != nil {
		t.Fatal(err)
	}
}
