//go:build windows

package handoff

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

func TestToolPrincipalMissingOnlyAcceptsUnmappedAccount(t *testing.T) {
	if !toolPrincipalMissing(fmt.Errorf("lookup: %w", toolAccountNotMapped)) {
		t.Fatal("wrapped unmapped account was not recognized")
	}
	for _, failure := range []error{nil, syscall.ERROR_ACCESS_DENIED, errors.New("invalid machine-local alias")} {
		if toolPrincipalMissing(failure) {
			t.Fatalf("unsafe lookup failure permits group creation: %v", failure)
		}
	}
}

func TestToolPrincipalExistingGroupIsIdempotent(t *testing.T) {
	expected := admissionFixture(t).principal
	actual, err := ensureToolPrincipal()
	if err != nil {
		t.Fatal(err)
	}
	if actual != expected {
		t.Fatal("existing local group identity changed")
	}
}

func TestToolAdmissionUsesPinnedCoordinatorToken(t *testing.T) {
	expected := admissionFixture(t)
	parent, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	actual, err := toolAdmissionFor(parent)
	if err != nil {
		t.Fatal(err)
	}
	if actual.owner != expected.owner || actual.principal != expected.principal {
		t.Fatal("tool admission did not bind the pinned coordinator identity")
	}
}

func TestToolAdmissionRejectsMissingCoordinator(t *testing.T) {
	var missing *windowsWaiter
	for _, parent := range []processWaiter{nil, missing} {
		if _, err := toolAdmissionFor(parent); err == nil {
			t.Fatal("missing pinned coordinator was accepted")
		}
	}
}

func TestToolAdmissionPrincipalOnlyCannotGrant(t *testing.T) {
	admission := &toolAdmission{principal: admissionFixture(t).principal}
	if err := admission.prepare(nil); err == nil {
		t.Fatal("receipt-only principal was allowed to grant tool permissions")
	}
}

func admissionFixture(t *testing.T) *toolAdmission {
	t.Helper()
	principal, err := resolveToolPrincipal()
	if err != nil {
		t.Skipf("native sandbox group unavailable: %v", err)
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	owner, err := user.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	return &toolAdmission{principal: principal, owner: owner}
}

func admissionPermissions(t *testing.T, path, sddl string) {
	t.Helper()
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor uintptr
	ok, _, callErr := security.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(text)), toolDescriptorRevision, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		t.Fatal(callErr)
	}
	defer kernel.NewProc("LocalFree").Call(descriptor)
	name, _ := syscall.UTF16PtrFromString(path)
	ok, _, callErr = security.NewProc("SetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), toolProtectedDACL|toolDACLInformation, descriptor)
	if ok == 0 {
		t.Fatal(callErr)
	}
}

func admissionACL(t *testing.T, path string, inspect func(unsafe.Pointer)) {
	t.Helper()
	handle, err := toolHandle(path, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	var acl, descriptor unsafe.Pointer
	status, _, _ := security.NewProc("GetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation, 0, 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	inspect(acl)
}

func TestToolAdmissionInheritedAtCreation(t *testing.T) {
	admission := admissionFixture(t)
	root := t.TempDir()
	admissionPermissions(t, root, "D:P(A;OICI;FA;;;"+admission.owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	stage, err := holdStage(root)
	if err != nil {
		t.Fatal(err)
	}
	defer stage.Close()
	if err := admission.prepare(stage); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "nested", "deeper")
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(directory, "tool.exe")
	if err := os.WriteFile(filename, []byte("newly extracted bytes"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := admission.prepare(stage); err == nil {
		t.Fatal("accepted a populated stage for inheritable ACL propagation")
	}
	if err := stage.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, directory, filename} {
		admissionACL(t, path, func(acl unsafe.Pointer) {
			if err := admission.validateACL(acl, admission.owner); err != nil {
				t.Fatal(err)
			}
			header := unsafe.Slice((*byte)(acl), toolACLHeaderBytes)
			bytes := unsafe.Slice((*byte)(acl), int(binary.LittleEndian.Uint16(header[2:4])))
			found := false
			for offset := toolACLHeaderBytes; offset < len(bytes); {
				ace := bytes[offset:]
				principal, err := (*syscall.SID)(unsafe.Add(acl, offset+toolACEHeaderBytes)).String()
				if err != nil {
					t.Fatal(err)
				}
				if principal == admission.principal && ace[0] == 0 {
					mask := toolMask(binary.LittleEndian.Uint32(ace[4:8]))
					if mask != toolReadExecute || ace[1]&toolInheritOnly != 0 {
						t.Fatalf("invalid sandbox rights %#x flags %#x", mask, ace[1])
					}
					found = true
				}
				offset += int(binary.LittleEndian.Uint16(ace[2:4]))
			}
			if !found {
				t.Fatalf("no sandbox RX on newly created %s", path)
			}
		})
	}
}

func TestToolAdmissionPinsPreventReplacement(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "nested")
	if err := os.Mkdir(child, 0755); err != nil {
		t.Fatal(err)
	}
	pins, err := pinLineage(child)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFiles(pins)
	for _, directory := range []string{root, child} {
		if err := os.Rename(directory, directory+".replaced"); err == nil {
			t.Fatalf("pinned ancestor permitted replacement: %s", directory)
		}
	}
	filename := filepath.Join(child, "tool.exe")
	if err := os.WriteFile(filename, []byte("tool"), 0644); err != nil {
		t.Fatal(err)
	}
	handle, err := toolHandle(filename, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	if err := os.Rename(filename, filename+".replaced"); err == nil {
		t.Fatal("pinned tool file permitted replacement")
	}
}

func TestToolAdmissionRejectsUnsafeACL(t *testing.T) {
	admission := admissionFixture(t)
	for _, extra := range []string{
		"(D;OICI;FRFX;;;" + admission.principal + ")",
		"(A;OICI;FA;;;" + admission.principal + ")",
		"(A;OICI;FW;;;BU)",
		"(A;OICIIO;FW;;;BU)",
	} {
		root := t.TempDir()
		admissionPermissions(t, root, "D:P(A;OICI;FA;;;"+admission.owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"+extra)
		stage, err := holdStage(root)
		if err != nil {
			t.Fatal(err)
		}
		defer stage.Close()
		if err := admission.prepare(stage); err == nil {
			t.Fatalf("accepted unsafe ACL %s", extra)
		}
	}
}

func TestToolAdmissionReceiptBindsSIDAndRoot(t *testing.T) {
	policy, runtime, archives := fixture(t)
	policy.toolAdmission = admissionFixture(t)
	var events []ComponentTiming
	policy.observeTiming = func(event ComponentTiming) { events = append(events, event) }
	root := t.TempDir()
	admissionPermissions(t, root, "D:P(A;OICI;FA;;;"+policy.toolAdmission.owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	runtime.Components = runtime.Components[:1]
	open := func(component Component) (*os.File, error) {
		file, err := os.CreateTemp(t.TempDir(), "archive")
		if err != nil {
			return nil, err
		}
		_, err = file.Write(archives[component.Kind])
		return file, err
	}
	results, err := policy.Prepare(root, runtime, open)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Metrics[timingPermissions].Calls != 1 {
		t.Fatalf("missing installation permission cost: %#v", events)
	}
	directory := results[0].Directory
	identity, err := toolRootIdentity(directory)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(directory, ReceiptName))
	if err != nil {
		t.Fatal(err)
	}
	var receipt Receipt
	if err = json.Unmarshal(raw, &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.AccessPolicy != toolAccessPolicy || receipt.PrincipalSID != policy.toolAdmission.principal || receipt.RootIdentity != identity {
		t.Fatalf("missing admission identity: %#v", receipt)
	}
	if reused, err := checkReuse(policy, root, runtime.Components[0]); err != nil || !reused {
		t.Fatalf("valid publication not reused: %v", err)
	}
	for _, change := range []func(*Receipt){
		func(value *Receipt) { value.AccessPolicy = 0 },
		func(value *Receipt) { value.PrincipalSID = "S-1-5-21-1-2-3-1234" },
		func(value *Receipt) { value.RootIdentity = "different" },
	} {
		changed := receipt
		change(&changed)
		bytes, _ := json.Marshal(changed)
		if err = os.WriteFile(filepath.Join(directory, ReceiptName), bytes, 0600); err != nil {
			t.Fatal(err)
		}
		if reused, err := checkReuse(policy, root, runtime.Components[0]); err == nil || reused {
			t.Fatal("stale admission reused")
		}
	}
}

func TestToolAdmissionFailureNeverPublishes(t *testing.T) {
	policy, runtime, archives := fixture(t)
	policy.toolAdmission = admissionFixture(t)
	policy.toolAdmission.principal = "S-1-5-21-1-2-3-1234"
	root := t.TempDir()
	runtime.Components = runtime.Components[:1]
	open := func(component Component) (*os.File, error) {
		file, err := os.CreateTemp(t.TempDir(), "archive")
		if err != nil {
			return nil, err
		}
		_, err = file.Write(archives[component.Kind])
		return file, err
	}
	if _, err := policy.Prepare(root, runtime, open); err == nil {
		t.Fatal("stale sandbox identity accepted")
	}
	directory, err := componentDirectory(root, runtime.Components[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("failed admission published a component: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(directory))
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed admission retained staging assets: %v %v", entries, err)
	}
}
