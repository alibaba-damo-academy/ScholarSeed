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
)

func installationPinsFixture(t *testing.T, root string) *installationPins {
	t.Helper()
	pins, err := pinInstallationParent(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pins.close(); err != nil {
			t.Error(err)
		}
	})
	return pins
}

func assertInstallationPinBlocksRename(t *testing.T, path string) {
	t.Helper()
	if err := os.Rename(path, path+"-moved"); !errors.Is(err, syscall.Errno(32)) {
		t.Fatalf("rename pinned directory %q: got %v, want sharing violation", path, err)
	}
}

func TestInstallationPinsOfficialRootReplacement(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "rollback"}[rollback], func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "书深 Application")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			data := filepath.Join(root, "preserved.txt")
			if err := os.WriteFile(data, []byte("unchanged"), 0600); err != nil {
				t.Fatal(err)
			}
			pins := installationPinsFixture(t, root)
			failure := errors.New("engine failed after rename")
			err := pins.replace(root, func() error {
				assertInstallationPinBlocksRename(t, parent)
				if err := os.Rename(root, root+".rollback"); err != nil {
					return err
				}
				if rollback {
					if err := os.Rename(root+".rollback", root); err != nil {
						return err
					}
					return failure
				}
				return os.Mkdir(root, 0700)
			})
			if rollback {
				if !errors.Is(err, failure) {
					t.Fatalf("engine error lost: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertInstallationPinBlocksRename(t, root)
				data = filepath.Join(root+".rollback", "preserved.txt")
			}
			assertInstallationPinBlocksRename(t, parent)
			if b, err := os.ReadFile(data); err != nil || string(b) != "unchanged" {
				t.Fatalf("data changed: %q %v", b, err)
			}
		})
	}
}

func TestInstallationPinsRejectInvalidReplacement(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "app")
	pins := installationPinsFixture(t, root)
	called := false
	install := func() error { called = true; return nil }
	if err := pins.replace(root, install); err == nil || called {
		t.Fatal("accepted missing leaf")
	}
	if err := pins.prepare(); err != nil {
		t.Fatal(err)
	}
	if err := pins.replace(parent, install); err == nil || called {
		t.Fatal("accepted ancestor replacement")
	}
	if err := pins.close(); err != nil {
		t.Fatal(err)
	}
	if err := pins.replace(root, install); err == nil || called {
		t.Fatal("accepted closed pins")
	}
}

func TestInstallationPinsRejectNonDirectoryReplacement(t *testing.T) {
	root := filepath.Join(t.TempDir(), "app")
	pins := installationPinsFixture(t, root)
	if err := pins.prepare(); err != nil {
		t.Fatal(err)
	}
	if err := pins.replace(root, func() error {
		if err := os.Rename(root, root+".old"); err != nil {
			return err
		}
		return os.WriteFile(root, []byte("not a directory"), 0600)
	}); err == nil {
		t.Fatal("accepted non-directory replacement")
	}
}

func TestInstallationPinsRejectReparseReplacement(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "app")
	target := t.TempDir()
	pins := installationPinsFixture(t, root)
	if err := pins.prepare(); err != nil {
		t.Fatal(err)
	}
	err := pins.replace(root, func() error {
		if err := os.Rename(root, root+".old"); err != nil {
			return err
		}
		installationJunctionFixture(t, root, target)
		return nil
	})
	if err == nil {
		t.Fatal("accepted junction replacement")
	}
	assertInstallationPinBlocksRename(t, parent)
}

func TestInstallationPinsPreserveExistingTree(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "书深 Application")
	for _, name := range []string{"current", "runtime"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	filename := filepath.Join(root, "user-data.txt")
	if err := os.WriteFile(filename, []byte("preserve existing contents"), 0600); err != nil {
		t.Fatal(err)
	}
	before := map[string]string{}
	for _, path := range []string{parent, root, filepath.Join(root, "current"), filepath.Join(root, "runtime"), filename} {
		before[path] = permissionFixtureSDDL(t, path)
	}
	pins := installationPinsFixture(t, root)
	if err := pins.prepare(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, parent} {
		assertInstallationPinBlocksRename(t, path)
	}
	for _, name := range []string{"current", "runtime"} {
		path := filepath.Join(root, name)
		if err := os.Rename(path, path+"-replacement"); err != nil {
			t.Fatalf("installation pin blocked replacement of %s: %v", name, err)
		}
		if err := os.Rename(path+"-replacement", path); err != nil {
			t.Fatal(err)
		}
	}
	for path, expected := range before {
		if actual := permissionFixtureSDDL(t, path); actual != expected {
			t.Fatalf("pin changed ACL at %q: %s -> %s", path, expected, actual)
		}
	}
	if contents, err := os.ReadFile(filename); err != nil || string(contents) != "preserve existing contents" {
		t.Fatalf("pin changed contents: %q, %v", contents, err)
	}
	if err := pins.close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(root, root+"-moved"); err != nil {
		t.Fatalf("root still pinned after close: %v", err)
	}
	if err := os.Rename(parent, parent+"-moved"); err != nil {
		t.Fatalf("ancestor still pinned after close: %v", err)
	}
	if err := os.Rename(parent+"-moved", parent); err != nil {
		t.Fatal(err)
	}
}

func TestInstallationPinsPrepareMissingLineage(t *testing.T) {
	parent := t.TempDir()
	owner := installationOwner(t)
	setPermissionFixture(t, parent, "D:P(A;OICI;FA;;;"+owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FW;;;BU)")
	intermediate := filepath.Join(parent, "missing")
	root := filepath.Join(intermediate, "nested", "application")
	before := permissionFixtureSDDL(t, parent)
	pins := installationPinsFixture(t, root)
	if _, err := os.Stat(intermediate); !os.IsNotExist(err) {
		t.Fatalf("pin created a missing directory: %v", err)
	}
	assertInstallationPinBlocksRename(t, parent)
	if err := pins.prepare(); err != nil {
		t.Fatal(err)
	}
	if err := pins.prepare(); err != nil {
		t.Fatalf("repeated prepare: %v", err)
	}
	for _, path := range []string{intermediate, filepath.Dir(root), root} {
		assertInstallationPinBlocksRename(t, path)
		if err := validatePermissions(path, false); err != nil {
			t.Fatalf("new directory is not private: %s: %v", path, err)
		}
		security := permissionFixtureSDDL(t, path)
		if !strings.Contains(security, "D:P") || strings.Contains(security, ";;;BU)") || !permissionFixtureUserFull(t, path, owner) {
			t.Fatalf("new directory inherited foreign write permissions: %s: %s", path, security)
		}
	}
	if actual := permissionFixtureSDDL(t, parent); actual != before {
		t.Fatal("prepare changed existing ancestor ACL")
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Fatalf("unexpected root contents: %v, %v", entries, err)
	}
	if err := pins.close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(intermediate, intermediate+"-moved"); err != nil {
		t.Fatal(err)
	}
	if err := pins.prepare(); err == nil {
		t.Fatal("prepare accepted closed pins")
	}
}

func TestInstallationPinNativeLayout(t *testing.T) {
	word := unsafe.Sizeof(uintptr(0))
	nameSize := 2 * word
	if word == 4 {
		nameSize = 8
	}
	if unsafe.Sizeof(installationPinName{}) != nameSize || unsafe.Offsetof(installationPinName{}.buffer) != word ||
		unsafe.Sizeof(installationPinAttributes{}) != 6*word || unsafe.Offsetof(installationPinAttributes{}.parent) != word ||
		unsafe.Offsetof(installationPinAttributes{}.name) != 2*word || unsafe.Offsetof(installationPinAttributes{}.security) != 4*word ||
		unsafe.Sizeof(installationPinStatus{}) != 2*word {
		t.Fatal("installation pin native structures do not match the Windows ABI")
	}
}

func installationJunctionFixture(t *testing.T, path, target string) {
	t.Helper()
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := syscall.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	}()
	substitute, err := syscall.UTF16FromString(`\??\` + target)
	if err != nil {
		t.Fatal(err)
	}
	printed, err := syscall.UTF16FromString(target)
	if err != nil {
		t.Fatal(err)
	}
	const mountPointTag = 0xa0000003
	const setReparsePoint = 0x000900a4
	const mountPointHeaderSize = 16
	data := make([]byte, mountPointHeaderSize+2*(len(substitute)+len(printed)))
	binary.LittleEndian.PutUint32(data[0:4], mountPointTag)
	binary.LittleEndian.PutUint16(data[4:6], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:12], uint16(2*(len(substitute)-1)))
	binary.LittleEndian.PutUint16(data[12:14], uint16(2*len(substitute)))
	binary.LittleEndian.PutUint16(data[14:16], uint16(2*(len(printed)-1)))
	names := append(substitute, printed...)
	for index, unit := range names {
		binary.LittleEndian.PutUint16(data[mountPointHeaderSize+2*index:], unit)
	}
	var returned uint32
	if err := syscall.DeviceIoControl(handle, setReparsePoint, &data[0], uint32(len(data)), nil, 0, &returned, nil); err != nil {
		t.Fatal(err)
	}
}

func TestInstallationPinsRejectJunctionsAndReleaseAncestors(t *testing.T) {
	parent := t.TempDir()
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(parent, "junction")
	installationJunctionFixture(t, link, target)
	for _, path := range []string{link, filepath.Join(link, "missing")} {
		pins, err := pinInstallationParent(path)
		if pins != nil || err == nil {
			if closeErr := pins.close(); closeErr != nil {
				t.Error(closeErr)
			}
			t.Fatalf("accepted junction lineage %q: %v", path, err)
		}
	}
	if err := os.Rename(parent, parent+"-moved"); err != nil {
		t.Fatalf("failed pin leaked ancestor handles: %v", err)
	}
	if err := os.Rename(parent+"-moved", parent); err != nil {
		t.Fatal(err)
	}
}

func TestInstallationPinsPrepareRejectsUnexpectedEntries(t *testing.T) {
	for _, kind := range []string{"directory", "file", "junction"} {
		t.Run(kind, func(t *testing.T) {
			parent := t.TempDir()
			missing := filepath.Join(parent, "missing")
			root := filepath.Join(missing, "application")
			pins := installationPinsFixture(t, root)
			switch kind {
			case "directory":
				if err := os.Mkdir(missing, 0700); err != nil {
					t.Fatal(err)
				}
			case "file":
				if err := os.WriteFile(missing, []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			case "junction":
				installationJunctionFixture(t, missing, t.TempDir())
			}
			if err := pins.prepare(); err == nil {
				t.Fatal("prepare accepted an entry created after initial pin")
			}
			if _, err := os.Stat(root); !os.IsNotExist(err) {
				t.Fatalf("prepare traversed unexpected entry: %v", err)
			}
		})
	}
}

func TestInstallationPinsRejectFilesAndInvalidPaths(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(filename, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filename, filepath.Join(filename, "missing"), "relative", `C:relative`, `\\server\share\application`, "C:\\invalid\x00path"} {
		pins, err := pinInstallationParent(path)
		if pins != nil || err == nil {
			if closeErr := pins.close(); closeErr != nil {
				t.Error(closeErr)
			}
			t.Fatalf("accepted invalid lineage %q: %v", path, err)
		}
	}
	if contents, err := os.ReadFile(filename); err != nil || string(contents) != "preserve" {
		t.Fatalf("pin changed file: %q, %v", contents, err)
	}
}

func TestInstallationPinsCloseReportsFailuresAndContinues(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "application")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	pins, err := pinInstallationParent(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.CloseHandle(pins.handles[len(pins.handles)-1].handle); err != nil {
		if closeErr := pins.close(); closeErr != nil {
			t.Error(closeErr)
		}
		t.Fatal(err)
	}
	if err := pins.close(); !errors.Is(err, syscall.Errno(6)) {
		t.Fatalf("close hid invalid-handle failure: %v", err)
	}
	if len(pins.handles) != 0 {
		t.Fatalf("close retained stale handles: %+v", pins.handles)
	}
	if err := pins.close(); err != nil {
		t.Fatalf("repeated close retried stale handles: %v", err)
	}
	if err := os.Rename(parent, parent+"-moved"); err != nil {
		t.Fatalf("close stopped before releasing ancestors: %v", err)
	}
	if err := os.Rename(parent+"-moved", parent); err != nil {
		t.Fatal(err)
	}
}
