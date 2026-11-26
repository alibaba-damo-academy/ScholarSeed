//go:build windows

package handoff

import (
	"errors"
	"path/filepath"
	"syscall"
	"testing"
)

func TestSandboxBinOwnerPreservesNativePolicy(t *testing.T) {
	// Match the worker's explicit privilege without widening the native DACL.
	// The helper restores the original token state after this test.
	sandboxTestPrivilege(t, "SeRestorePrivilege", true)
	home, user := sandboxTestNativeBin(t)
	target := filepath.Join(home, ".sandbox-bin")
	child := filepath.Join(target, "untouched")
	sandboxTestDirectory(t, child, "O:"+user+"D:(A;;FA;;;"+user+")(A;;FA;;;SY)")
	h, err := sandboxOpen(target, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	before, err := sandboxSnapshot(h)
	if err != nil {
		t.Fatal(err)
	}
	c, err := sandboxOpen(child, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(c)
	childBefore, err := sandboxSnapshot(c)
	if err != nil {
		t.Fatal(err)
	}
	elevated := func(string) error { t.Fatal("elevated native test unexpectedly requested UAC"); return nil }
	if err = sandboxEnsureBinOwner(home, user, elevated); err != nil {
		t.Fatal(err)
	}
	after, err := sandboxSnapshot(h)
	if err != nil {
		t.Fatal(err)
	}
	if !sandboxOwnerRestored(before, after, sandboxAdminSID) {
		t.Fatal("bin transfer changed native policy")
	}
	childAfter, err := sandboxSnapshot(c)
	if err != nil || childAfter.fingerprint() != childBefore.fingerprint() {
		t.Fatalf("descendant changed: %v", err)
	}
	if err = sandboxEnsureBinOwner(home, user, elevated); err != nil {
		t.Fatal(err)
	}
	writer, err := sandboxOpen(target, toolReadControl|toolWriteDACL)
	if err != nil {
		t.Fatal(err)
	}
	syscall.CloseHandle(writer)
}

func sandboxTestNativeBin(t *testing.T) (home, user string) {
	t.Helper()
	user = metadataTestUser(t)
	const reader = "S-1-5-21-1-2-3-1002"
	home = t.TempDir()
	sandboxTestDirectory(t, filepath.Join(home, ".sandbox-bin"), "O:"+user+"D:P(A;OICI;0x1701bf;;;"+user+")(A;OICI;0x1301bf;;;SY)(A;OICI;0x1301bf;;;BA)(A;OICI;FRFX;;;"+reader+")")
	return
}

func TestSandboxBinOwnerWithoutPrivilegeRequiresElevation(t *testing.T) {
	home, user := sandboxTestNativeBin(t)
	h, err := sandboxOpen(filepath.Join(home, ".sandbox-bin"), toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	before, err := sandboxSnapshot(h)
	if err != nil {
		t.Fatal(err)
	}
	denied := errors.New("test elevation declined")
	calls := 0
	sandboxTestWithoutPrivileges(t, func() {
		err = sandboxEnsureBinOwner(home, user, func(expected string) error {
			calls++
			if expected != before.fingerprint() {
				t.Fatal("elevation did not bind the original security snapshot")
			}
			return denied
		})
	})
	if !errors.Is(err, denied) || calls != 1 {
		t.Fatalf("missing elevation boundary: calls=%d err=%v", calls, err)
	}
	after, err := sandboxSnapshot(h)
	if err != nil || after.fingerprint() != before.fingerprint() {
		t.Fatalf("declined elevation changed native policy: %v", err)
	}
}

func TestSandboxBinOwnerRequiresExplicitUserMaintenance(t *testing.T) {
	user := metadataTestUser(t)
	home := t.TempDir()
	target := filepath.Join(home, ".sandbox-bin")
	sandboxTestDirectory(t, target, "O:"+user+"D:P(A;;0x1201bf;;;"+user+")(A;;FA;;;SY)(A;;FA;;;BA)")
	if err := sandboxEnsureBinOwner(home, user, func(string) error { t.Fatal("unsafe ownership requested elevation"); return nil }); err == nil {
		t.Fatal("owner transfer could remove original-user maintenance")
	}
}

func TestSandboxSetupWriterPreservesPrivateBoundary(t *testing.T) {
	user := metadataTestUser(t)
	group := "S-1-5-21-1-2-3-1002"
	target := filepath.Join(t.TempDir(), sandboxSecrets)
	sandboxTestDirectory(t, target, "O:"+user+"D:P(D;OICI;0x1301bf;;;"+group+")(A;OICI;0x1201bf;;;"+user+")(A;OICI;0x1301bf;;;SY)(A;OICI;0x1301bf;;;BA)")
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
	targetHandle, targetErr := sandboxOpen(target, toolReadControl)
	if targetErr != nil {
		t.Fatal(targetErr)
	}
	targetBefore, targetErr := sandboxSnapshot(targetHandle)
	syscall.CloseHandle(targetHandle)
	if targetErr != nil {
		t.Fatal(targetErr)
	}
	if err = sandboxEnsureSetupWriter(target, user, group, targetBefore.identity); err != nil {
		t.Fatal(err)
	}
	after, err := sandboxSnapshot(h)
	if err != nil || before.fingerprint() != after.fingerprint() {
		t.Fatalf("private descendant changed: %v", err)
	}
	if err = sandboxEnsureSetupWriter(target, user, group, targetBefore.identity); err != nil {
		t.Fatal(err)
	}
}

func TestSandboxBinWorkerRejectsStaleOrMissingCoordinator(t *testing.T) {
	user := metadataTestUser(t)
	profile := filepath.Join(t.TempDir(), "profile")
	product := filepath.Join(profile, ".scholarseed")
	home := filepath.Join(product, "codex")
	target := filepath.Join(home, ".sandbox-bin")
	for _, path := range []string{profile, product, home, target} {
		sandboxTestDirectory(t, path, "O:"+user+"D:P(A;;FA;;;"+user+")(A;;FA;;;SY)(A;;FA;;;BA)")
	}
	h, err := sandboxOpen(target, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	before, err := sandboxSnapshot(h)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"", "stale", before.fingerprint()} {
		if err = sandboxBinOwnerWorker(home, user, "", expected, nil); err == nil {
			t.Fatal("unsafe worker accepted")
		}
	}
	after, err := sandboxSnapshot(h)
	if err != nil || before.fingerprint() != after.fingerprint() {
		t.Fatalf("rejected worker changed target: %v", err)
	}
}
