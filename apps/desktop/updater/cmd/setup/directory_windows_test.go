package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func TestInstallDirectoryPolicy(t *testing.T) {
	c := configuration{AppID: "scholarseed", MaxRootUnits: 250}
	root := t.TempDir()
	empty := filepath.Join(root, "书深 Apps")
	if err := validateDirectory(empty, "", c); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(empty, 0700); err != nil {
		t.Fatal(err)
	}
	if err := validateDirectory(empty, "", c); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(empty, "user-data.txt"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateDirectory(empty, "", c); err == nil {
		t.Fatal("accepted foreign nonempty folder")
	}
	for _, bad := range []string{`C:\`, `.\relative`, `\\server\share\app`, filepath.Join(root, "CON.txt"), filepath.Join(root, "trailing."), filepath.Join(root, "bad\x01name"), filepath.Join(root, strings.Repeat("x", 251))} {
		if err := validateDirectory(bad, "", c); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if err := validateDirectory(filepath.Join(root, "other"), empty, c); err == nil {
		t.Fatal("accepted implicit migration")
	}
}

func TestAssessDirectoryReturnsAncestorRisksWithoutChangingParent(t *testing.T) {
	parent := t.TempDir()
	owner := installationOwner(t)
	setPermissionFixture(t, parent, "D:P(A;OICI;FA;;;"+owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FW;;;BU)")
	before := permissionFixtureSDDL(t, parent)
	root := filepath.Join(parent, "书深 Application")
	config := configuration{AppID: "scholarseed", MaxRootUnits: 250}
	risks, err := assessDirectory(root, "", config)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, risk := range risks {
		if risk.Path == parent && risk.Principal == "S-1-5-32-545" && risk.Reason == "access" && risk.Mask != 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing parent write risk: %+v", risks)
	}
	if err := validateDirectory(root, "", config); err != nil {
		t.Fatalf("risk was treated as hard rejection: %v", err)
	}
	if err := validatePermissions(parent, true); err == nil {
		t.Fatal("strict ancestor validation was weakened")
	}
	if after := permissionFixtureSDDL(t, parent); after != before {
		t.Fatal("assessment modified parent ACL")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("assessment left root or probe behind: %v, %v", entries, err)
	}
}

func TestAssessDirectoryUsesProtectedCreationInsteadOfPredictedInheritance(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		inherit    string
		components []string
		existing   bool
		wantRisk   bool
	}{
		{name: "existing-leaf", inherit: "OICIIO", components: []string{"application"}, existing: true},
		{name: "direct-missing-leaf", inherit: "OICIIO", components: []string{"application"}},
		{name: "missing-intermediate", inherit: "OICIIO", components: []string{"missing", "application"}},
		{name: "multiple-missing-intermediates", inherit: "OICIIO", components: []string{"missing", "nested", "application"}},
		{name: "container-inherit-only", inherit: "CIIO", components: []string{"missing", "application"}},
		{name: "object-inherit-only", inherit: "OIIO", components: []string{"missing", "application"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// t.TempDir includes the long test name. Under a CI-depth native build
			// root that can exceed this ACL fixture's directory length policy.
			// Keep the same owned temporary root, without the test-name prefix.
			parent, err := os.MkdirTemp("", "acl-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(parent); err != nil {
					t.Error(err)
				}
			})
			owner := installationOwner(t)
			setPermissionFixture(t, parent, "D:P(A;OICI;FA;;;"+owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;"+scenario.inherit+";FW;;;BU)")
			root := filepath.Join(append([]string{parent}, scenario.components...)...)
			if scenario.existing {
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
			}
			before := permissionFixtureSDDL(t, parent)
			if risks, err := inspectAncestorPermissions(parent); err != nil || len(risks) != 0 {
				t.Fatalf("inherit-only ACE incorrectly affects existing parent: risks=%+v err=%v", risks, err)
			}
			if err := validatePermissions(parent, true); err != nil {
				t.Fatalf("strict existing ancestor policy changed: %v", err)
			}
			config := configuration{AppID: "scholarseed", MaxRootUnits: 250}
			for attempt := 0; attempt < 2; attempt++ {
				risks, err := assessDirectory(root, "", config)
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, risk := range risks {
					if risk.Path == parent && risk.Principal == "S-1-5-32-545" && risk.Reason == "access" && risk.Mask != 0 {
						found = true
					}
				}
				if found != scenario.wantRisk {
					t.Fatalf("nearest-existing parent risk=%v, want %v: %+v", found, scenario.wantRisk, risks)
				}
				if after := permissionFixtureSDDL(t, parent); after != before {
					t.Fatal("assessment changed nearest-existing parent ACL")
				}
				entries, err := os.ReadDir(parent)
				if err != nil {
					t.Fatal(err)
				}
				if scenario.existing {
					if len(entries) != 1 || entries[0].Name() != scenario.components[0] || !entries[0].IsDir() {
						t.Fatalf("assessment changed existing directory contents: %v", entries)
					}
				} else {
					if len(entries) != 0 {
						t.Fatalf("assessment created intermediate directories or left a probe: %v", entries)
					}
					if _, err := os.Lstat(root); !os.IsNotExist(err) {
						t.Fatalf("assessment created installation root or inspection failed: %v", err)
					}
				}
			}
		})
	}
}

func TestAssessDirectoryKeepsHardRejectionsDespiteAncestorRisk(t *testing.T) {
	parent := t.TempDir()
	owner := installationOwner(t)
	setPermissionFixture(t, parent, "D:P(A;OICI;FA;;;"+owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FW;;;BU)")
	occupied := filepath.Join(parent, "occupied")
	if err := os.Mkdir(occupied, 0700); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(occupied, "user-data.txt")
	if err := os.WriteFile(filename, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	config := configuration{AppID: "scholarseed", MaxRootUnits: 250}
	for _, candidate := range []string{occupied, filepath.Join(parent, "CON.txt"), filepath.Join(parent, "trailing."), filepath.Join(parent, strings.Repeat("x", 251))} {
		if risks, err := assessDirectory(candidate, "", config); err == nil {
			t.Errorf("hard-invalid path %q became consentable: %+v", candidate, risks)
		}
		if err := validateDirectory(candidate, "", config); err == nil {
			t.Errorf("validation accepted hard-invalid path %q", candidate)
		}
	}
	if _, err := assessDirectory(filepath.Join(parent, "relocated"), occupied, config); err == nil {
		t.Fatal("assessment accepted relocation")
	}
	if contents, err := os.ReadFile(filename); err != nil || string(contents) != "preserve" {
		t.Fatalf("assessment modified user data: %q, %v", contents, err)
	}
}

func TestAssessDirectoryRequiresSuccessfulWriteProbe(t *testing.T) {
	restore := ordinaryFilesystemToken(t)
	defer restore()
	parent := t.TempDir()
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	userSID, err := user.User.Sid.String()
	if err != nil {
		t.Fatal(err)
	}
	setPermissionFixture(t, parent, "D:P(D;;0x00000004;;;"+userSID+")(A;OICI;FA;;;"+userSID+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	before := permissionFixtureSDDL(t, parent)
	control := filepath.Join(parent, "denied-creation-control")
	if err := os.Mkdir(control, 0700); err == nil {
		removeErr := os.Remove(control)
		t.Fatalf("fixture did not deny child creation: parent=%q tokenUser=%s acl=%s cleanup=%v", parent, userSID, before, removeErr)
	} else if !os.IsPermission(err) {
		t.Fatalf("fixture failed for a reason other than access denial: parent=%q tokenUser=%s acl=%s error=%v", parent, userSID, before, err)
	}
	root := filepath.Join(parent, "application")
	config := configuration{AppID: "scholarseed", MaxRootUnits: 250}
	if risks, err := assessDirectory(root, "", config); err == nil {
		t.Fatalf("unwritable parent became consentable: %+v", risks)
	} else {
		var issue *directoryIssue
		if !errors.As(err, &issue) || issue.Code != directoryNotWritable || issue.Path != root {
			t.Fatalf("expected write-probe hard failure for %q, got %v", root, err)
		}
	}
	if err := validateDirectory(root, "", config); err == nil {
		t.Fatal("validation bypassed write probe")
	} else {
		var issue *directoryIssue
		if !errors.As(err, &issue) || issue.Code != directoryNotWritable || issue.Path != root {
			t.Fatalf("validation failed outside write probe for %q: %v", root, err)
		}
	}
	if after := permissionFixtureSDDL(t, parent); after != before {
		t.Fatal("failed probe changed parent ACL")
	}
	if entries, err := os.ReadDir(parent); err != nil || len(entries) != 0 {
		t.Fatalf("failed probe left files: %v, %v", entries, err)
	}
}

// OpenSSH administrative sessions can enable Backup/Restore privileges. Go's
// filesystem operations use backup intent, so such a token can legitimately
// bypass an ACL denial. Scope this denial fixture to a thread token without
// those privileges; never change the process token or production behavior.
func ordinaryFilesystemToken(t *testing.T) func() {
	t.Helper()
	const disableMaxPrivilege = 1
	const noThreadToken = syscall.Errno(1008)
	runtime.LockOSThread()
	ready := false
	var previous syscall.Token
	defer func() {
		if !ready {
			if previous != 0 {
				previous.Close()
			}
			runtime.UnlockOSThread()
		}
	}()
	thread, _, _ := kernel.NewProc("GetCurrentThread").Call()
	ok, _, err := permissionAPI.NewProc("OpenThreadToken").Call(thread, syscall.TOKEN_QUERY|syscall.TOKEN_IMPERSONATE, 1, uintptr(unsafe.Pointer(&previous)))
	if ok == 0 && err != noThreadToken {
		t.Fatalf("capture fixture thread token: %v", err)
	}
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		t.Fatal(err)
	}
	var original syscall.Token
	if err := syscall.OpenProcessToken(process, syscall.TOKEN_QUERY|syscall.TOKEN_DUPLICATE, &original); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	var restricted syscall.Token
	ok, _, err = permissionAPI.NewProc("CreateRestrictedToken").Call(uintptr(original), disableMaxPrivilege, 0, 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
	if ok == 0 {
		t.Fatalf("create ordinary fixture token: %v", err)
	}
	defer restricted.Close()
	ok, _, err = permissionAPI.NewProc("ImpersonateLoggedOnUser").Call(uintptr(restricted))
	if ok == 0 {
		t.Fatalf("install ordinary fixture token: %v", err)
	}
	ready = true
	return func() {
		t.Helper()
		if previous != 0 {
			ok, _, err = permissionAPI.NewProc("SetThreadToken").Call(0, uintptr(previous))
			previous.Close()
		} else {
			ok, _, err = permissionAPI.NewProc("RevertToSelf").Call()
		}
		if ok == 0 {
			// Do not return an impersonating thread to the scheduler on failure.
			t.Fatalf("restore fixture thread token: %v", err)
		}
		runtime.UnlockOSThread()
	}
}

func TestReinstallDoesNotScanRuntimeMembers(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "current"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"Update.exe":              "executable",
		"current/ScholarSeed.exe": "executable",
		"current/sq.version":      "<package><metadata><id>scholarseed</id></metadata></package>",
	} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := secureInstallation(root); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "runtime", "python", strings.Repeat("a", 160), strings.Repeat("b", 160))
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	if err := validateDirectory(root, root, configuration{AppID: "scholarseed", MaxRootUnits: 250}); err != nil {
		t.Fatalf("runtime member incorrectly entered installer path preflight: %v", err)
	}
}
func TestRegisteredInstallationIdentity(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"Update.exe": "executable", "current/ScholarSeed.exe": "executable", "current/sq.version": "<package><metadata><id>scholarseed</id></metadata></package>"} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := verifyInstalled(root, "scholarseed"); err != nil {
		t.Fatal(err)
	}
	if err := verifyInstalled(root, "foreign"); err == nil {
		t.Fatal("foreign product accepted")
	}
}

func TestRegisteredEmptyInstallationRecovery(t *testing.T) {
	for _, present := range []bool{false, true} {
		root := filepath.Join(t.TempDir(), "书深 Custom")
		if present {
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
		}
		if err := verifyRegisteredDirectory(root, "scholarseed"); err != nil {
			t.Fatalf("empty registered root (present=%v) must allow reinstallation: %v", present, err)
		}
		if err := validateDirectory(root, root, configuration{AppID: "scholarseed", MaxRootUnits: 250}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRegisteredRecoveryPreservesNonemptyDirectory(t *testing.T) {
	for _, name := range []string{"user-data.txt", "Update.exe", "current"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, name)
			if err := os.WriteFile(path, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := verifyRegisteredDirectory(root, "scholarseed"); err == nil {
				t.Fatal("accepted incomplete nonempty installation")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != "preserve" {
				t.Fatalf("modified existing data: %q %v", got, err)
			}
		})
	}
}

func TestRegisteredRecoveryRejectsLinks(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{link, filepath.Join(link, "missing")} {
		if err := verifyRegisteredDirectory(path, "scholarseed"); err == nil {
			t.Fatalf("accepted linked recovery root: %s", path)
		}
	}
}

func TestFinalPreparationChecksConsentAfterPrivateCreation(t *testing.T) {
	for _, scenario := range []struct {
		name, before, after     string
		mutate, created, benign bool
	}{
		{name: "unchanged-effective", before: "(A;OICI;FW;;;BU)"},
		{name: "unchanged-prospective", before: "(A;OICIIO;FW;;;BU)"},
		{name: "added-risk", after: "(A;OICI;FW;;;BU)", mutate: true},
		{name: "removed-risk", before: "(A;OICI;FW;;;BU)", mutate: true},
		{name: "snapshot-only-change", before: "(A;OICI;FW;;;BU)", after: "(A;OICI;FW;;;BU)(A;OICI;FRFX;;;WD)", mutate: true, benign: true},
		{name: "prospective-change", before: "(A;OICIIO;FW;;;BU)", after: "(A;OICIIO;FA;;;BU)", mutate: true, benign: true},
		{name: "new-private-ancestor-changed", before: "(A;OICIIO;FW;;;BU)", after: "(A;OICI;FW;;;BU)", mutate: true, created: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			parent := t.TempDir()
			owner := installationOwner(t)
			private := "D:P(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
			setPermissionFixture(t, parent, private+scenario.before)
			root := filepath.Join(parent, "missing", "nested", "application")
			config := configuration{AppID: "scholarseed", MaxRootUnits: 250}
			pins := installationPinsFixture(t, root)
			risks, err := assessDirectory(root, "", config)
			if err != nil {
				t.Fatal(err)
			}
			consent := captureDirectoryConsent(risks)
			if err := pins.prepare(); err != nil {
				t.Fatal(err)
			}
			target := parent
			if scenario.created {
				target = filepath.Dir(root)
			}
			if scenario.mutate {
				setPermissionFixture(t, target, private+scenario.after)
			}
			rootBefore := permissionFixtureSDDL(t, root)
			targetBefore := permissionFixtureSDDL(t, target)
			err = prepareInstallationDirectory(root, "", config, consent)
			if scenario.mutate && !scenario.benign {
				var issue *directoryIssue
				if !errors.As(err, &issue) || issue.Code != directoryRiskChanged {
					t.Fatalf("observed risk change was not blocked: %v", err)
				}
				if permissionFixtureSDDL(t, root) != rootBefore || permissionFixtureSDDL(t, target) != targetBefore {
					t.Fatal("risk rejection changed existing permissions")
				}
			} else if err != nil {
				t.Fatalf("own private ancestor creation invalidated unchanged consent: %v", err)
			}
		})
	}
}

func TestRegisteredRecoveryPreparesRootAndRechecksContents(t *testing.T) {
	c := configuration{AppID: "scholarseed", MaxRootUnits: 250}
	for _, present := range []bool{false, true} {
		root := filepath.Join(t.TempDir(), "app")
		if present {
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
		}
		risks, err := assessDirectory(root, root, c)
		if err != nil {
			t.Fatal(err)
		}
		consent := captureDirectoryConsent(risks)
		if err := prepareInstallationDirectory(root, root, c, consent); err != nil {
			t.Fatal(err)
		}
		if err := validatePermissions(root, false); err != nil {
			t.Fatal(err)
		}
		if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
			t.Fatalf("unexpected root contents: %v %v", entries, err)
		}
		if err := verifyRegisteredDirectory(root, "scholarseed"); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(root, "user-data.txt")
		if err := os.WriteFile(path, []byte("preserve"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := prepareInstallationDirectory(root, root, c, consent); err == nil {
			t.Fatal("accepted contents added after discovery")
		}
		if data, err := os.ReadFile(path); err != nil || string(data) != "preserve" {
			t.Fatal("changed foreign data")
		}
	}
}
