//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func TestSandboxMetadataFailureDiagnostic(t *testing.T) {
	user := metadataTestUser(t)
	home := t.TempDir()
	target := filepath.Join(home, ".sandbox-bin")
	sandboxTestDirectory(t, target, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)(A;;FR;;;WD)")
	handle, err := sandboxOpen(target, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	before, err := sandboxSnapshot(handle)
	if err != nil {
		t.Fatal(err)
	}
	failure := sandboxPrepareBin(home, user, "")
	if failure == nil {
		t.Fatal("unsafe policy accepted")
	}
	diagnostic := SandboxDiagnostic(sandboxFailure(sandboxStageMetadata, failure))
	var stdout, stderr bytes.Buffer
	WriteSandboxDiagnostic(&stdout, &stderr, sandboxFailure(sandboxStageMetadata, failure))
	if stdout.String() != "{\"event\":\"failed\",\"stage\":\"metadata\",\"reason\":\"policy_rejected\"}\n" {
		t.Fatalf("legacy receipt changed: %s", stdout.String())
	}
	raw, err := json.Marshal(diagnostic)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["object"] != "sandbox_bin" || fields["rule"] != "unknown_principal" || SandboxExitCode(sandboxFailure(sandboxStageMetadata, failure)) != 4102 {
		t.Fatalf("lost safe metadata classification: %s", raw)
	}
	if strings.TrimSpace(stderr.String()) != string(raw) {
		t.Fatal("native diagnostic channel lost metadata detail")
	}
	t.Logf("native receipt=%s detail=%s exit=%d", strings.TrimSpace(stdout.String()), strings.TrimSpace(stderr.String()), SandboxExitCode(sandboxFailure(sandboxStageMetadata, failure)))
	if strings.Contains(string(raw), user) || strings.Contains(string(raw), home) || strings.Contains(string(raw), "SDDL") {
		t.Fatal("private diagnostic escaped")
	}
	after, err := sandboxSnapshot(handle)
	if err != nil || after.fingerprint() != before.fingerprint() {
		t.Fatalf("rejected policy changed: %v", err)
	}
}

func TestSandboxPrivatePreparationWithOrdinaryProfileAccess(t *testing.T) {
	sandboxTestPrivilege(t, "SeRestorePrivilege", true)
	user := metadataTestUser(t)
	other, group, reader := "S-1-5-21-1-2-3-1003", "S-1-5-21-1-2-3-1002", "S-1-5-5-1-2"
	profile := filepath.Join(t.TempDir(), "profile")
	product, home := filepath.Join(profile, sandboxProduct), filepath.Join(profile, sandboxProduct, sandboxHomeName)
	sandboxTestDirectory(t, profile, "O:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1201bf;;;"+other+")(A;OICI;FA;;;"+user+")")
	sandboxTestDirectory(t, product, "O:"+user+"D:P(A;;FA;;;SY)(A;;FA;;;"+user+")")
	sandboxTestDirectory(t, home, "O:"+user+"D:P(A;;FA;;;SY)(A;;FA;;;"+user+")")
	sandboxTestDirectory(t, filepath.Join(home, sandboxMetadata), "O:BAD:(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;"+reader+")")
	profileHandle, err := sandboxOpen(profile, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(profileHandle)
	before, err := sandboxSnapshot(profileHandle)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := sandboxPrepareMetadata(home, user, group, reader); err != nil {
			t.Fatalf("ordinary profile access blocked private preparation: %+v", SandboxDiagnostic(sandboxFailure(sandboxStageMetadata, err)))
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".sandbox-bin")); err != nil {
		t.Fatalf("necessary bin preparation missing: %v", err)
	}
	after, err := sandboxSnapshot(profileHandle)
	if err != nil || after.fingerprint() != before.fingerprint() {
		t.Fatalf("profile security was modified: %v", err)
	}
}

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
			classification := SandboxDiagnostic(sandboxFailure(sandboxStageMetadata, sandboxMetadataFailure(sandboxObjectMetadata, err)))
			want := sandboxRulePrincipal
			if strings.HasPrefix(extra, "(D;") {
				want = sandboxRuleDeny
			} else if extra == "(A;;FA;;;S-1-5-21-1-2-3-1002)" {
				want = sandboxRuleGroupMask
			}
			if classification.Rule != want || classification.Object != sandboxObjectMetadata {
				t.Fatalf("unsafe policy classification lost: %+v", classification)
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
	diagnostic := SandboxDiagnostic(sandboxFailure(sandboxStageMetadata, sandboxMetadataFailure(sandboxObjectLog, err)))
	if diagnostic.Rule != sandboxRuleHardlink || diagnostic.Object != sandboxObjectLog {
		t.Fatalf("hardlink classification lost: %+v", diagnostic)
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

// Native fixtures deliberately change security after planning, without a global
// syscall hook or a race whose timing decides whether the regression runs.
type sandboxMetadataFixture struct {
	closeLog               func() error
	home, user, group, log string
	changes                []sandboxMetadataChange
	child                  syscall.Handle
	childBefore            sandboxSecurity
}

func sandboxMetadataTestACL(t *testing.T, handle syscall.Handle, acl []byte) {
	t.Helper()
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation, 0, 0, uintptr(unsafe.Pointer(&acl[0])), 0)
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
}

func sandboxMetadataTestFixture(t *testing.T) sandboxMetadataFixture {
	t.Helper()
	fixture := sandboxMetadataFixture{user: metadataTestUser(t), group: "S-1-5-21-1-2-3-1002"}
	profile := filepath.Join(t.TempDir(), "profile")
	fixture.home = filepath.Join(profile, sandboxProduct, sandboxHomeName)
	target := filepath.Join(fixture.home, sandboxMetadata)
	for _, path := range []string{profile, filepath.Dir(fixture.home), fixture.home, target} {
		sandboxTestDirectory(t, path, "O:"+fixture.user+"D:PAI(A;OICI;FA;;;"+fixture.user+")(A;OICI;FA;;;SY)")
	}
	dir, err := sandboxOpen(target, sandboxMaximumAllowed)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.CloseHandle(dir) })
	before, err := sandboxSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Complete native auto-inheritance normalization before the planned snapshot.
	sandboxMetadataTestACL(t, dir, before.acl)
	fixture.log = filepath.Join(target, "sandbox.2026-11-20.log")
	if err = os.WriteFile(fixture.log, []byte("metadata fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	name, _ := syscall.UTF16PtrFromString(fixture.log)
	log, err := syscall.CreateFile(name, sandboxMaximumAllowed, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	fixture.closeLog = func() error {
		if log == 0 {
			return nil
		}
		err := syscall.CloseHandle(log)
		if err == nil {
			log = 0
		}
		return err
	}
	t.Cleanup(func() {
		if err := fixture.closeLog(); err != nil {
			t.Errorf("close fixture log: %v", err)
		}
	})
	owner, err := syscall.StringToSid(fixture.user)
	if err != nil {
		t.Fatal(err)
	}
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(log), toolFileObject, toolOwnerInformation, uintptr(unsafe.Pointer(owner)), 0, 0, 0)
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
	for index, handle := range []syscall.Handle{dir, log} {
		directory := index == 0
		snapshot, err := sandboxObjectSnapshot(handle, directory)
		if err != nil {
			t.Fatal(err)
		}
		acl, err := sandboxMetadataACL(snapshot, fixture.user, fixture.group, directory)
		if err != nil {
			t.Fatal(err)
		}
		object := sandboxObjectLog
		if directory {
			object = sandboxObjectMetadata
		}
		fixture.changes = append(fixture.changes, sandboxMetadataChange{handle, snapshot, acl, directory, object})
	}
	untouched := filepath.Join(target, "untouched")
	sandboxTestDirectory(t, untouched, "O:"+fixture.user+"D:(A;;FA;;;"+fixture.user+")(A;;FA;;;SY)")
	fixture.child, err = sandboxOpen(untouched, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.CloseHandle(fixture.child) })
	fixture.childBefore, err = sandboxSnapshot(fixture.child)
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func sandboxMetadataTestDrift(t *testing.T, fixture sandboxMetadataFixture, index int) sandboxSecurity {
	t.Helper()
	change := fixture.changes[index]
	acl, err := sandboxAppendDirectoryGrant(change.before.acl, fixture.user, sandboxAttributes)
	if err != nil {
		t.Fatal(err)
	}
	sandboxMetadataTestACL(t, change.handle, acl)
	current, err := sandboxObjectSnapshot(change.handle, change.directory)
	if err != nil {
		t.Fatal(err)
	}
	if current.identity != change.before.identity || current.owner != change.before.owner || current.control != change.before.control || bytes.Equal(current.acl, change.before.acl) {
		t.Fatal("fixture did not isolate ACL drift")
	}
	return current
}

func TestSandboxMetadataApplyRequalifies(t *testing.T) {
	fixture := sandboxMetadataTestFixture(t)
	current := sandboxMetadataTestDrift(t, fixture, 0)
	logCurrent := sandboxMetadataTestDrift(t, fixture, 1)
	logExpected, err := sandboxMetadataACL(logCurrent, fixture.user, fixture.group, false)
	if err != nil {
		t.Fatal(err)
	}
	want, err := sandboxMetadataACL(current, fixture.user, fixture.group, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = sandboxMetadataApply(fixture.home, fixture.user, fixture.group, fixture.changes); err != nil {
		t.Fatalf("qualified same-object ACL drift rejected: %v", err)
	}
	after, err := sandboxSnapshot(fixture.changes[0].handle)
	if err != nil || !bytes.Equal(after.acl, want) || after.identity != current.identity || after.owner != current.owner || after.control != current.control {
		t.Fatalf("fresh ACEs were not retained: %v", err)
	}
	logAfter, err := sandboxObjectSnapshot(fixture.changes[1].handle, false)
	if err != nil {
		t.Fatal(err)
	}
	logWant, err := sandboxMetadataACL(logAfter, fixture.user, fixture.group, false)
	if err != nil || !bytes.Equal(logWant, logAfter.acl) || !bytes.Equal(logAfter.acl, logExpected) {
		t.Fatalf("fresh log ACEs or maintenance lost: %v", err)
	}
	childAfter, err := sandboxSnapshot(fixture.child)
	if err != nil || childAfter.fingerprint() != fixture.childBefore.fingerprint() {
		t.Fatalf("unrelated descendant changed: %v", err)
	}
	// The MAXIMUM_ALLOWED pin can include DELETE; release it before a normal
	// os.ReadFile open, whose sharing mode need not permit that retained access.
	if err = fixture.closeLog(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(fixture.log)
	if err != nil || string(got) != "metadata fixture\n" {
		t.Fatalf("log contents changed: %v", err)
	}
}

func TestSandboxMetadataApplyRejectsUnsafeRequalification(t *testing.T) {
	for _, kind := range []string{"metadata principal", "metadata deny", "metadata group", "log principal", "home principal"} {
		t.Run(kind, func(t *testing.T) {
			fixture := sandboxMetadataTestFixture(t)
			current := sandboxMetadataTestDrift(t, fixture, 0)
			handle, acl := fixture.changes[0].handle, current.acl
			switch kind {
			case "metadata principal":
				acl = sandboxTestAppendACE(t, acl, "S-1-1-0", 0, toolInheritChildren|toolInheritOnly, toolFullAccess)
			case "metadata deny":
				acl = sandboxTestAppendACE(t, acl, sandboxAdminSID, 1, 0, sandboxAttributes)
			case "metadata group":
				acl = sandboxTestAppendACE(t, acl, fixture.group, 0, 0, toolFullAccess)
			case "log principal":
				handle = fixture.changes[1].handle
				acl = sandboxTestAppendACE(t, fixture.changes[1].before.acl, "S-1-1-0", 0, 0, toolReadExecute)
			case "home principal":
				var err error
				handle, err = sandboxOpen(fixture.home, sandboxMaximumAllowed)
				if err != nil {
					t.Fatal(err)
				}
				defer syscall.CloseHandle(handle)
				before, err := sandboxSnapshot(handle)
				if err != nil {
					t.Fatal(err)
				}
				acl = sandboxTestAppendACE(t, before.acl, "S-1-1-0", 0, 0, toolFullAccess)
			}
			sandboxMetadataTestACL(t, handle, acl)
			var observed []sandboxSecurity
			for _, change := range fixture.changes {
				snapshot, err := sandboxObjectSnapshot(change.handle, change.directory)
				if err != nil {
					t.Fatal(err)
				}
				observed = append(observed, snapshot)
			}
			if err := sandboxMetadataApply(fixture.home, fixture.user, fixture.group, fixture.changes); err == nil {
				t.Fatal("unsafe replanning accepted")
			}
			for index, change := range fixture.changes {
				after, err := sandboxObjectSnapshot(change.handle, change.directory)
				if err != nil || after.fingerprint() != observed[index].fingerprint() {
					t.Fatalf("rejected requalification changed object %d: %v", index, err)
				}
			}
		})
	}
}

func TestSandboxMetadataApplyRejectsChangedBinding(t *testing.T) {
	for _, index := range []int{0, 1} {
		for _, field := range []string{"identity", "owner", "control"} {
			t.Run(fmt.Sprintf("object=%d/%s", index, field), func(t *testing.T) {
				fixture := sandboxMetadataTestFixture(t)
				sandboxMetadataTestDrift(t, fixture, 0)
				before := &fixture.changes[index].before
				switch field {
				case "identity":
					before.identity += ":stale"
				case "owner":
					before.owner = sandboxSystemSID
				case "control":
					const protectedControl = 0x1000
					before.control ^= protectedControl
				}
				current, err := sandboxSnapshot(fixture.changes[0].handle)
				if err != nil {
					t.Fatal(err)
				}
				if err = sandboxMetadataApply(fixture.home, fixture.user, fixture.group, fixture.changes); err == nil {
					t.Fatal("changed object binding accepted")
				}
				after, err := sandboxSnapshot(fixture.changes[0].handle)
				if err != nil || after.fingerprint() != current.fingerprint() {
					t.Fatalf("binding rejection wrote metadata: %v", err)
				}
			})
		}
	}
}

func TestSandboxMetadataApplyKeepsLogDriftStrict(t *testing.T) {
	fixture := sandboxMetadataTestFixture(t)
	directory := &fixture.changes[0]
	sandboxMetadataTestACL(t, directory.handle, directory.acl)
	var err error
	directory.before, err = sandboxSnapshot(directory.handle)
	if err != nil {
		t.Fatal(err)
	}
	directory.acl = bytes.Clone(directory.before.acl)
	current := sandboxMetadataTestDrift(t, fixture, 1)
	err = sandboxMetadataApply(fixture.home, fixture.user, fixture.group, fixture.changes)
	diagnostic := SandboxDiagnostic(sandboxFailure(sandboxStageMetadata, err))
	if err == nil || diagnostic.Object != sandboxObjectLog || diagnostic.Rule != sandboxRuleDrift {
		t.Fatalf("log drift did not remain strict: %+v", diagnostic)
	}
	after, err := sandboxObjectSnapshot(fixture.changes[1].handle, false)
	if err != nil || after.fingerprint() != current.fingerprint() {
		t.Fatalf("stale log snapshot was written: %v", err)
	}
}

// A fresh plan is not a grant to overwrite another subsequent policy change.
func TestSandboxMetadataReplanKeepsWriterStrict(t *testing.T) {
	fixture := sandboxMetadataTestFixture(t)
	sandboxMetadataTestDrift(t, fixture, 0)
	fresh, err := sandboxMetadataReplan(fixture.home, fixture.user, fixture.group, fixture.changes)
	if err != nil {
		t.Fatal(err)
	}
	first := fresh[0]
	acl, err := sandboxAppendDirectoryGrant(first.before.acl, fixture.user, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	sandboxMetadataTestACL(t, first.handle, acl)
	current, err := sandboxSnapshot(first.handle)
	if err != nil {
		t.Fatal(err)
	}
	err = sandboxMetadataWrite(first.handle, first.before, first.acl, first.directory)
	var check *sandboxCheckError
	if !errors.As(err, &check) || check.rule != sandboxRuleDrift {
		t.Fatalf("second ACL drift accepted: %v", err)
	}
	after, err := sandboxSnapshot(first.handle)
	if err != nil || after.fingerprint() != current.fingerprint() {
		t.Fatalf("stale replan changed security: %v", err)
	}
}
