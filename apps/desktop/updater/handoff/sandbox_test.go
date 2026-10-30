package handoff

import (
	"encoding/json"
	"errors"
	"strings"
	"syscall"
	"testing"
)

func TestSandboxAncestorTraversalIsBounded(t *testing.T) {
	for _, flags := range []byte{0, 0x10} {
		for _, mask := range []uint32{0x20, 0x100000, 0x100020} {
			if !sandboxAncestorTraversal(mask, flags) {
				t.Fatal("directory-only traversal was rejected")
			}
		}
	}
	for _, mask := range []uint32{1, 2, 0x80, 0x20000, 0x40000, 0x80000, 0x10000, 0x100021, 0x80000000} {
		if sandboxAncestorTraversal(mask, 0) {
			t.Fatalf("extra access accepted: %x", mask)
		}
	}
	for _, flags := range []byte{1, 2, 3, 4, 8, 0x11, 0x12, 0x80} {
		if sandboxAncestorTraversal(0x100020, flags) {
			t.Fatalf("propagating or unknown ACE flags accepted: %x", flags)
		}
	}
}

func TestSandboxDiagnosticsNeverExposeNativeMessages(t *testing.T) {
	for _, cause := range []error{errors.New("private-token"), syscall.Errno(5), syscall.Errno(1314), ErrCancelled} {
		failure := sandboxFailure(sandboxStageElevation, cause)
		diagnostic := SandboxDiagnostic(failure)
		raw, err := json.Marshal(diagnostic)
		if err != nil || strings.Contains(string(raw)+failure.Error(), "private-token") || diagnostic.Stage != sandboxStageElevation {
			t.Fatalf("unsafe diagnostic: %s", raw)
		}
		decoded := SandboxDiagnostic(sandboxWorkerFailure(uint32(SandboxExitCode(failure))))
		if decoded.Stage != diagnostic.Stage || decoded.Reason != diagnostic.Reason {
			t.Fatal("worker lost its bounded failure classification")
		}
	}
	unknown := SandboxDiagnostic(sandboxWorkerFailure(1))
	if unknown.Stage != sandboxStageWorker || unknown.Reason != sandboxReasonWorker {
		t.Fatal("unknown worker exit was trusted")
	}
}

func TestSandboxWorkerDiagnosticsRoundTripEveryClassification(t *testing.T) {
	seen := map[int]bool{}
	for _, stage := range sandboxDiagnosticStages {
		for _, reason := range sandboxDiagnosticReasons {
			cause := &sandboxDiagnosticError{sandboxDiagnostic{Event: sandboxFailed, Stage: stage, Reason: reason}}
			code := SandboxExitCode(cause)
			if code == 0 || seen[code] {
				t.Fatal("worker classifications share an exit code")
			}
			seen[code] = true
			decoded := SandboxDiagnostic(sandboxWorkerFailure(uint32(code)))
			if decoded != cause.diagnostic {
				t.Fatalf("worker classification changed: %#v", decoded)
			}
		}
	}
}

func TestSandboxCancellationRequiresActualCancellationResult(t *testing.T) {
	for _, entry := range []struct {
		cause  error
		reason string
		code   uint32
	}{
		{ErrCancelled, sandboxReasonCancelled, 0},
		{errors.New("UAC cancelled"), sandboxReasonPolicy, 0},
		{syscall.Errno(5), sandboxReasonAccess, 5},
		{syscall.Errno(1300), sandboxReasonPrivilege, 1300},
		{syscall.Errno(1314), sandboxReasonPrivilege, 1314},
		{syscall.Errno(2), sandboxReasonSystem, 2},
	} {
		diagnostic := SandboxDiagnostic(sandboxFailure(sandboxStageElevation, entry.cause))
		if diagnostic.Reason != entry.reason || diagnostic.SystemError != entry.code {
			t.Fatalf("wrong native result classification: %#v", diagnostic)
		}
	}
}

func TestSandboxRecoveryVersionIsExact(t *testing.T) {
	for _, version := range []string{"0.163.0", "0.165.0"} {
		if err := validateSandboxVersion(version); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []string{"", "0.159.0", "0.163.0-r1", "0.164.0", "0.163.0\n", "0.165.0-r1", "0.166.0", "0.165.0\n", "codex-cli 0.165.0"} {
		if validateSandboxVersion(version) == nil {
			t.Fatalf("unreviewed version accepted: %q", version)
		}
	}
}

func TestSandboxRuntimeVersionMatchesRequestedExecution(t *testing.T) {
	for _, version := range []string{"0.163.0", "0.165.0"} {
		for _, revision := range []string{"-r1", "-r12"} {
			if !sandboxRuntimeVersionMatches(version, version+revision) {
				t.Fatalf("matching reviewed runtime rejected: %s%s", version, revision)
			}
		}
		for _, componentVersion := range []string{"", version, version + "-r", version + "-r0", version + "-r01", version + "-r1\n", version + "-r1-extra", "0.164.0-r1", "0.166.0-r1"} {
			if sandboxRuntimeVersionMatches(version, componentVersion) {
				t.Fatalf("unreviewed component accepted: %q for %s", componentVersion, version)
			}
		}
	}
	for _, entry := range [][2]string{{"0.165.0", "0.163.0-r1"}, {"0.163.0", "0.165.0-r1"}, {"0.166.0", "0.166.0-r1"}} {
		if sandboxRuntimeVersionMatches(entry[0], entry[1]) {
			t.Fatalf("runtime identity substitution accepted: %q", entry)
		}
	}
}

func TestTemporaryFullControlCannotHideAdministrativeOwner(t *testing.T) {
	for _, writable := range []bool{true, false} {
		if sandboxPreparationEvent(sandboxAdminSID, "original-user", writable) != sandboxRepairRequired {
			t.Fatal("temporary user grant left the persistent owner mismatch")
		}
	}
	if sandboxPreparationEvent("original-user", "original-user", true) != sandboxUnchanged {
		t.Fatal("healthy user owner requires no change")
	}
	if sandboxPreparationEvent("original-user", "original-user", false) != sandboxUnsupported {
		t.Fatal("owner-rights denial must not trigger elevation")
	}
}

func TestSandboxPreparationClassifiesOnlyKnownOwnerRecovery(t *testing.T) {
	user := "original-user"
	for _, entry := range []struct {
		owner    string
		writable bool
		event    string
	}{
		{user, true, sandboxUnchanged},
		{user, false, sandboxUnsupported},
		{sandboxAdminSID, true, sandboxRepairRequired},
		{sandboxAdminSID, false, sandboxRepairRequired},
		{"S-1-5-18", true, sandboxUnsupported},
		{"another-user", true, sandboxUnsupported},
		{"another-user", false, sandboxUnsupported},
	} {
		if event := sandboxPreparationEvent(entry.owner, user, entry.writable); event != entry.event {
			t.Fatalf("owner=%s writable=%v: got %s, want %s", entry.owner, entry.writable, event, entry.event)
		}
	}
}
