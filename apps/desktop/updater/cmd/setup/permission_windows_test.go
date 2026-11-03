package main

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"scholarseed.local/desktop/updater/internal/security"
)

func setPermissionFixture(t *testing.T, path, sddl string) {
	t.Helper()
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor unsafe.Pointer
	ok, _, err := permissionAPI.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		t.Fatal(err)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	name, _ := syscall.UTF16PtrFromString(path)
	ok, _, err = permissionAPI.NewProc("SetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), 0x80000004, uintptr(descriptor))
	if ok == 0 {
		t.Fatal(err)
	}
}

func TestDirectoryPermissionPolicy(t *testing.T) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
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
	// Only this test's fresh directory is modified; callers set TEMP to the task root.
	root := t.TempDir()
	base := "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	for _, test := range []struct {
		name, extra    string
		ancestor, want bool
	}{
		{"private", "", false, true},
		{"public-read", "(A;OICI;FRFX;;;BU)", false, true},
		{"public-write", "(A;OICI;FW;;;BU)", false, false},
		{"public-add-leaf", "(A;OICI;0x00000006;;;BU)", false, false},
		{"public-add-ancestor", "(A;OICI;0x00000006;;;BU)", true, true},
		{"public-write-ancestor", "(A;OICI;FW;;;BU)", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(root, test.name)
			if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
			setPermissionFixture(t, path, base+test.extra)
			err := validatePermissions(path, test.ancestor)
			if (err == nil) != test.want {
				t.Fatalf("validatePermissions = %v, want allowed %v", err, test.want)
			}
		})
	}
}

func TestPermissionAuthority(t *testing.T) {
	for _, sid := range []string{"S-1-5-21-1-2-3-1001", "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"} {
		if !security.Authority(sid, "S-1-5-21-1-2-3-1001") {
			t.Fatalf("rejected authority %s", sid)
		}
	}
	if security.Authority("S-1-5-32-545", "S-1-5-21-1-2-3-1001") {
		t.Fatal("Users must not be an authority")
	}
}

func TestAncestorPermissionRisksPreserveStrictPolicy(t *testing.T) {
	owner := installationOwner(t)
	base := "D:P(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	for _, scenario := range []struct {
		name, extra               string
		wantRisk, wantStrictError bool
	}{
		{name: "private"},
		{name: "foreign-read", extra: "(A;OICI;FRFX;;;BU)"},
		{name: "deny-after-owner-allow", extra: "(D;;FRFX;;;BU)"},
		{name: "foreign-add-children", extra: "(A;OICI;0x00000006;;;BU)"},
		{name: "foreign-write", extra: "(A;OICI;FW;;;BU)", wantRisk: true, wantStrictError: true},
		{name: "foreign-delete", extra: "(A;;SD;;;BU)", wantRisk: true, wantStrictError: true},
		{name: "inherit-only-write", extra: "(A;OICIIO;FW;;;BU)"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			setPermissionFixture(t, root, base+scenario.extra)
			before := permissionFixtureSDDL(t, root)
			risks, err := inspectAncestorPermissions(root)
			if err != nil {
				t.Fatal(err)
			}
			if scenario.wantRisk {
				if len(risks) != 1 || risks[0].Path != root || risks[0].Principal != "S-1-5-32-545" || risks[0].Reason != "access" || risks[0].Mask == 0 {
					t.Fatalf("unexpected ancestor risks: %+v", risks)
				}
			} else if len(risks) != 0 {
				t.Fatalf("spurious ancestor risks: %+v", risks)
			}
			if err := validatePermissions(root, true); (err != nil) != scenario.wantStrictError {
				t.Fatalf("strict ancestor policy changed: %v", err)
			}
			if after := permissionFixtureSDDL(t, root); after != before {
				t.Fatalf("inspection modified ACL: %s -> %s", before, after)
			}
		})
	}
}

func TestAncestorPermissionInspectionRejectsUnsafeDescriptors(t *testing.T) {
	owner := installationOwner(t)
	objectGUID := "7a432dc2-6958-4f10-8f62-44ed7426fe2c"
	for _, scenario := range []struct{ name, descriptor string }{
		{"null-dacl", "D:NO_ACCESS_CONTROL"},
		{"unsupported-object-ace", "D:P(A;OICI;FA;;;" + owner + ")(OA;;FW;" + objectGUID + ";;BU)"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			setPermissionFixture(t, root, scenario.descriptor)
			before := permissionFixtureSDDL(t, root)
			if scenario.name == "unsupported-object-ace" && (!strings.Contains(before, "(OA;") || !strings.Contains(strings.ToLower(before), objectGUID)) {
				t.Fatalf("filesystem did not preserve the unsupported object ACE fixture: %s", before)
			}
			if risks, err := inspectAncestorPermissions(root); err == nil {
				t.Fatalf("unsafe descriptor became consentable: %+v", risks)
			}
			if after := permissionFixtureSDDL(t, root); after != before {
				t.Fatal("rejected ACL was modified")
			}
		})
	}
}

func TestAncestorPermissionInspectionRejectsNonDirectories(t *testing.T) {
	root := t.TempDir()
	filename := filepath.Join(root, "file")
	if err := os.WriteFile(filename, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{filename, filepath.Join(root, "missing")} {
		if risks, err := inspectAncestorPermissions(candidate); err == nil {
			t.Fatalf("uninspectable path %q became consentable: %+v", candidate, risks)
		}
	}
	if contents, err := os.ReadFile(filename); err != nil || string(contents) != "preserve" {
		t.Fatalf("inspection changed file: %q, %v", contents, err)
	}
}

func TestAncestorForeignOwnerRisk(t *testing.T) {
	root := t.TempDir()
	owner := installationOwner(t)
	setPermissionFixture(t, root, "D:P(A;OICI;FA;;;"+owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	text, err := syscall.UTF16PtrFromString("O:BU")
	if err != nil {
		t.Fatal(err)
	}
	var descriptor unsafe.Pointer
	ok, _, err := permissionAPI.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		t.Fatal(err)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	name, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		t.Fatal(err)
	}
	ok, _, err = permissionAPI.NewProc("SetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), 1, uintptr(descriptor))
	if ok == 0 {
		if errors.Is(err, syscall.Errno(5)) || errors.Is(err, syscall.Errno(1307)) || errors.Is(err, syscall.Errno(1314)) {
			t.Skipf("temporary foreign-owner fixture requires existing owner-setting authority: %v", err)
		}
		t.Fatal(err)
	}
	before := permissionFixtureSDDL(t, root)
	risks, err := inspectAncestorPermissions(root)
	if err != nil || len(risks) != 1 || risks[0].Path != root || risks[0].Principal != "S-1-5-32-545" || risks[0].Reason != "owner" {
		t.Fatalf("foreign owner risks=%+v err=%v", risks, err)
	}
	if err := validatePermissions(root, true); err == nil {
		t.Fatal("strict validation accepted foreign owner")
	}
	if after := permissionFixtureSDDL(t, root); after != before {
		t.Fatal("foreign owner inspection changed ACL")
	}
}

func permissionFixtureSDDL(t *testing.T, path string) string {
	t.Helper()
	name, _ := syscall.UTF16PtrFromString(path)
	var descriptor unsafe.Pointer
	status, _, _ := permissionAPI.NewProc("GetNamedSecurityInfoW").Call(uintptr(unsafe.Pointer(name)), permissionFileObject, 4, 0, 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	var output *uint16
	var length uint32
	ok, _, err := permissionAPI.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW").Call(uintptr(descriptor), 1, 4, uintptr(unsafe.Pointer(&output)), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		t.Fatal(err)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(unsafe.Pointer(output)))
	return syscall.UTF16ToString(unsafe.Slice(output, int(length)))
}

func permissionFixtureUserFull(t *testing.T, path, userSID string) bool {
	t.Helper()
	name, _ := syscall.UTF16PtrFromString(path)
	var acl, descriptor unsafe.Pointer
	status, _, _ := permissionAPI.NewProc("GetNamedSecurityInfoW").Call(uintptr(unsafe.Pointer(name)), permissionFileObject, 4, 0, 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	if acl == nil {
		return false
	}
	valid, _, _ := permissionAPI.NewProc("IsValidAcl").Call(uintptr(acl))
	if valid == 0 {
		t.Fatal("invalid fixture ACL")
	}
	header := unsafe.Slice((*byte)(acl), 8)
	data := unsafe.Slice((*byte)(acl), int(binary.LittleEndian.Uint16(header[2:4])))
	count := int(binary.LittleEndian.Uint16(header[4:6]))
	position := 8
	for i := 0; i < count; i++ {
		ace := data[position:]
		length := int(binary.LittleEndian.Uint16(ace[2:4]))
		if ace[0] == 0 && ace[1]&permissionInheritOnly == 0 {
			sid, err := permissionSID(unsafe.Add(acl, position+8))
			if err != nil {
				t.Fatal(err)
			}
			if sid == userSID && binary.LittleEndian.Uint32(ace[4:8])&0x001f01ff == 0x001f01ff {
				return true
			}
		}
		position += length
	}
	return false
}

func TestSecureInstallationOwnTreeOnly(t *testing.T) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
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
	parent := t.TempDir()
	setPermissionFixture(t, parent, "D:P(A;OICI;FA;;;"+sid+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FW;;;BU)")
	before := permissionFixtureSDDL(t, parent)
	root := filepath.Join(parent, "application")
	child := filepath.Join(root, "current")
	if err = os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(child, "program.bin")
	if err = os.WriteFile(file, []byte("owned fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = validatePermissions(root, false); err == nil {
		t.Fatal("fixture must inherit unsafe permissions")
	}
	if err = secureInstallation(root); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, child} {
		if err = validatePermissions(path, false); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{root, child, file} {
		sddl := permissionFixtureSDDL(t, path)
		if strings.Contains(sddl, ";;;BU)") || !strings.Contains(sddl, "D:P") || !permissionFixtureUserFull(t, path, sid) {
			t.Fatalf("unexpected private ACL: %s", sddl)
		}
	}
	if after := permissionFixtureSDDL(t, parent); after != before {
		t.Fatalf("parent ACL changed: %s -> %s", before, after)
	}
	if content, err := os.ReadFile(file); err != nil || string(content) != "owned fixture" {
		t.Fatalf("file changed: %q %v", content, err)
	}
}

func installationOwner(t *testing.T) string {
	t.Helper()
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
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
	return sid
}

func TestSecureInstallationPreservesRuntimeStore(t *testing.T) {
	root := t.TempDir()
	sid := installationOwner(t)
	private := "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	setPermissionFixture(t, root, private)
	store := filepath.Join(root, "runtime")
	nested := filepath.Join(store, "python", "reviewed-r2", "nested")
	current := filepath.Join(root, "current")
	for _, directory := range []string{nested, current} {
		if err := os.MkdirAll(directory, 0755); err != nil {
			t.Fatal(err)
		}
	}
	filename := filepath.Join(nested, "asset.bin")
	version := []byte("<package><metadata><id>scholarseed</id><version>0.2.0-build.202610170001</version></metadata></package>")
	if err := os.WriteFile(filepath.Join(current, "sq.version"), version, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte("preserved tool"), 0644); err != nil {
		t.Fatal(err)
	}
	setPermissionFixture(t, store, private+"(A;OICI;FRFX;;;BU)")
	setPermissionFixture(t, filename, private+"(A;;FRFX;;;BU)")
	setPermissionFixture(t, current, private+"(A;OICI;FW;;;BU)")
	before := map[string]string{}
	for _, path := range []string{root, store, nested, filename} {
		before[path] = permissionFixtureSDDL(t, path)
	}
	if err := secureInstallation(root); err != nil {
		t.Fatal(err)
	}
	for path, expected := range before {
		if actual := permissionFixtureSDDL(t, path); actual != expected {
			t.Fatalf("preserved boundary ACL changed at %s: %s -> %s", path, expected, actual)
		}
	}
	if err := validatePermissions(current, false); err != nil {
		t.Fatal(err)
	}
	if actual := permissionFixtureSDDL(t, current); strings.Contains(actual, ";;;BU)") {
		t.Fatal("application tree was not privatized")
	}
}

func TestSecureInstallationRejectsUntrustedRuntimeBoundary(t *testing.T) {
	for _, target := range []string{"", "runtime"} {
		t.Run(target, func(t *testing.T) {
			root := t.TempDir()
			sid := installationOwner(t)
			private := "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
			setPermissionFixture(t, root, private)
			store := filepath.Join(root, "runtime")
			if err := os.Mkdir(store, 0755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, target)
			setPermissionFixture(t, path, private+"(A;OICI;FW;;;BU)")
			before := permissionFixtureSDDL(t, path)
			if err := secureInstallation(root); err == nil {
				t.Fatal("untrusted preserved installation boundary was accepted")
			}
			if after := permissionFixtureSDDL(t, path); after != before {
				t.Fatal("rejected boundary was rewritten")
			}
		})
	}
}

func TestSecureInstallationRejectsRuntimeFile(t *testing.T) {
	root := t.TempDir()
	sid := installationOwner(t)
	setPermissionFixture(t, root, "D:P(A;OICI;FA;;;"+sid+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err := os.WriteFile(filepath.Join(root, "runtime"), []byte("not a directory"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := secureInstallation(root); err == nil {
		t.Fatal("runtime file was accepted as a preserved directory boundary")
	}
}

func TestRuntimeBoundaryRejectsInheritedOnlyForeignWrite(t *testing.T) {
	testRuntimeBoundaryInheritedACE(t, "(A;OICIIO;FW;;;BU)")
}

func TestRuntimeBoundaryRejectsInheritedOnlyReadExecuteDeny(t *testing.T) {
	testRuntimeBoundaryInheritedACE(t, "(D;OICIIO;FRFX;;;BU)")
}

func testRuntimeBoundaryInheritedACE(t *testing.T, inheritedACE string) {
	t.Helper()
	for _, target := range []string{"", "runtime"} {
		t.Run(target, func(t *testing.T) {
			root := t.TempDir()
			sid := installationOwner(t)
			private := "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
			setPermissionFixture(t, root, private)
			store := filepath.Join(root, "runtime")
			current := filepath.Join(root, "current")
			for _, directory := range []string{store, current} {
				if err := os.Mkdir(directory, 0755); err != nil {
					t.Fatal(err)
				}
				setPermissionFixture(t, directory, private)
			}
			path := filepath.Join(root, target)
			descriptor := private + inheritedACE
			if strings.HasPrefix(inheritedACE, "(D;") {
				// Denies after a complete allow do not deny access. Exercise a
				// genuinely effective inherited deny, rather than the old scan.
				descriptor = "D:P" + inheritedACE + strings.TrimPrefix(private, "D:P")
			}
			setPermissionFixture(t, path, descriptor)
			if err := validatePermissions(path, false); err != nil {
				t.Fatalf("fixture must reach the stricter runtime boundary policy: %v", err)
			}
			before := map[string]string{}
			for _, directory := range []string{root, store, current} {
				before[directory] = permissionFixtureSDDL(t, directory)
			}
			if err := secureInstallation(root); err == nil {
				t.Fatal("unsafe inherited-only runtime boundary ACE was accepted")
			}
			for directory, expected := range before {
				if actual := permissionFixtureSDDL(t, directory); actual != expected {
					t.Fatalf("rejected boundary changed ACL at %s: %s -> %s", directory, expected, actual)
				}
			}
		})
	}
}

func TestPermissionVolumeRootUsesOpenedObject(t *testing.T) {
	path := t.TempDir()
	for _, item := range []struct {
		path string
		root bool
	}{{path, false}, {filepath.VolumeName(path) + `\`, true}} {
		handle, err := openInstallationPin(item.path)
		if err != nil {
			t.Fatal(err)
		}
		got, err := permissionVolumeRoot(handle)
		syscall.CloseHandle(handle)
		if err != nil || got != item.root {
			t.Fatalf("%s root=%v err=%v", item.path, got, err)
		}
	}
}

func TestUnrelatedDenyDoesNotRejectRuntime(t *testing.T) {
	root := t.TempDir()
	user := installationOwner(t)
	unrelated := "S-1-5-21-111-222-333-444"
	setPermissionFixture(t, root, "D:P(D;OICI;FRFX;;;"+unrelated+")(A;OICI;FA;;;"+user+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err := validatePermissionMode(root, false, true); err != nil {
		t.Fatal(err)
	}
}

func TestCapabilityCannotGrantAncestorAuthority(t *testing.T) {
	root := t.TempDir()
	user := installationOwner(t)
	setPermissionFixture(t, root, "D:P(A;OICI;FA;;;"+user+")(A;;WD;;;S-1-15-3-1234)")
	risks, err := inspectAncestorPermissions(root)
	if err != nil || len(risks) != 1 {
		t.Fatalf("risks=%+v err=%v", risks, err)
	}
}

func TestLegacyLocatorDoesNotWeakenScheduledCleanup(t *testing.T) {
	parent := t.TempDir()
	user := installationOwner(t)
	setPermissionFixture(t, parent, "D:P(A;OICI;FA;;;"+user+")(A;OICI;FW;;;BU)")
	before := permissionFixtureSDDL(t, parent)
	if err := legacySafeTree(parent, false); err != nil {
		t.Fatal(err)
	}
	if err := legacySafeTree(filepath.Join(parent, "absent", "staging"), true); err == nil {
		t.Fatal("absent cleanup could be injected by a parent writer")
	}
	if err := legacySafeTree(parent, true); err == nil {
		t.Fatal("existing destructive target accepted foreign writes")
	}
	if after := permissionFixtureSDDL(t, parent); after != before {
		t.Fatal("locator rewrote parent ACL")
	}
}

func TestPermissionDriveAliasDoesNotGetVolumeExemption(t *testing.T) {
	const rawTarget, removeDefinition, exactMatch = 1, 2, 4
	drives, _, err := kernel.NewProc("GetLogicalDrives").Call()
	if drives == 0 {
		t.Fatal(err)
	}
	var name string
	for letter := 'Z'; letter >= 'D'; letter-- {
		if drives&(1<<uint(letter-'A')) == 0 {
			name = string(letter) + ":"
			break
		}
	}
	if name == "" {
		t.Skip("no free task-owned drive alias")
	}
	root := t.TempDir()
	alias, _ := syscall.UTF16PtrFromString(name)
	target, _ := syscall.UTF16PtrFromString(`\??\` + root)
	define := kernel.NewProc("DefineDosDeviceW")
	ok, _, err := define.Call(rawTarget, uintptr(unsafe.Pointer(alias)), uintptr(unsafe.Pointer(target)))
	if ok == 0 {
		t.Fatal(err)
	}
	// Remove only this task's exact mapping, never another mapping for the letter.
	defer func() {
		ok, _, err := define.Call(rawTarget|removeDefinition|exactMatch, uintptr(unsafe.Pointer(alias)), uintptr(unsafe.Pointer(target)))
		if ok == 0 {
			t.Errorf("remove task alias %s: %v", name, err)
		}
	}()
	handle, err := openInstallationPin(name + `\`)
	if err != nil {
		t.Fatal(err)
	}
	physical, err := permissionVolumeRoot(handle)
	syscall.CloseHandle(handle)
	if err != nil || physical {
		t.Fatalf("alias classified as physical root: %v %v", physical, err)
	}
}

func TestRealPhysicalVolumeAdmission(t *testing.T) {
	path := os.Getenv("SCHOLARSEED_TEST_VOLUME_ROOT")
	if path == "" {
		t.Skip("explicit read-only test volume not selected")
	}
	handle, err := openInstallationPin(path)
	if err != nil {
		t.Fatal(err)
	}
	root, err := permissionVolumeRoot(handle)
	syscall.CloseHandle(handle)
	if err != nil || !root {
		t.Fatalf("not a physical volume: root=%v err=%v", root, err)
	}
	if err := validatePermissions(path, true); err != nil {
		t.Fatal(err)
	}
	risks, err := inspectAncestorPermissions(path)
	if err != nil || len(risks) != 0 {
		t.Fatalf("volume risks=%+v err=%v", risks, err)
	}
}
