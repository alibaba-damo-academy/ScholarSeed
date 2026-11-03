package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

const registryCreatedNewKey = 1
const orphanRegistryPrefix = `Software\ScholarSeedTests-NSISOrphan-`

// Use an owned registry subtree as the hive. Never edit real product registration.
func orphanRegistryFixture(t *testing.T, view uint32) syscall.Handle {
	t.Helper()
	// Wall-clock timestamps can repeat between the two registry views on CI.
	// Keep the shared prefix for inventory; cleanup owns only this exact new key.
	name := fmt.Sprintf("%s%d-%d-%s", orphanRegistryPrefix, os.Getpid(), view, rand.Text())
	root := orphanCreateKey(t, syscall.HKEY_CURRENT_USER, name, view)
	t.Logf("owned registry fixture: %s (view=%d)", name, view)
	t.Cleanup(func() {
		code, _, _ := permissionAPI.NewProc("RegDeleteTreeW").Call(uintptr(root), 0)
		syscall.RegCloseKey(root)
		if code != 0 {
			t.Errorf("delete fixture contents: %v", syscall.Errno(code))
		}
		code, _, _ = permissionAPI.NewProc("RegDeleteKeyExW").Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(utf(name))), uintptr(view), 0)
		if code != 0 {
			t.Errorf("delete fixture root: %v", syscall.Errno(code))
		}
	})
	return root
}
func orphanCreateKey(t *testing.T, root syscall.Handle, name string, view uint32) syscall.Handle {
	t.Helper()
	key, err := orphanNewKey(root, name, view)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func orphanNewKey(root syscall.Handle, name string, view uint32) (syscall.Handle, error) {
	var key syscall.Handle
	var disposition uint32
	code, _, _ := permissionAPI.NewProc("RegCreateKeyExW").Call(uintptr(root), uintptr(unsafe.Pointer(utf(name))), 0, 0, 0, uintptr(syscall.KEY_ALL_ACCESS|view), 0, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&disposition)))
	if code != 0 {
		return 0, fmt.Errorf("create registry fixture %s (view=%d): %w", name, view, syscall.Errno(code))
	}
	if disposition != registryCreatedNewKey {
		// Never mutate or register cleanup for a key owned by another fixture.
		syscall.RegCloseKey(key)
		return 0, fmt.Errorf("registry fixture already exists: %s (view=%d, disposition=%d)", name, view, disposition)
	}
	return key, nil
}

func TestOrphanRegistryFixtureRejectsReuse(t *testing.T) {
	for _, view := range []uint32{syscall.KEY_WOW64_64KEY, syscall.KEY_WOW64_32KEY} {
		t.Run(fmt.Sprint(view), func(t *testing.T) {
			hive := orphanRegistryFixture(t, view)
			key := orphanCreateKey(t, hive, legacyInstallKey, view)
			defer syscall.RegCloseKey(key)
			orphanSetString(t, key, "KeepShortcuts", "preserve")
			if reused, err := orphanNewKey(hive, legacyInstallKey, view); err == nil || reused != 0 {
				if reused != 0 {
					syscall.RegCloseKey(reused)
				}
				t.Fatalf("existing fixture accepted: handle=%d err=%v", reused, err)
			}
			if value, err := registryString(key, "KeepShortcuts"); err != nil || value != "preserve" {
				t.Fatalf("collision modified original fixture: %q %v", value, err)
			}
		})
	}
}
func orphanSetString(t *testing.T, key syscall.Handle, name, value string) {
	t.Helper()
	data, err := syscall.UTF16FromString(value)
	if err != nil {
		t.Fatal(err)
	}
	code, _, _ := permissionAPI.NewProc("RegSetValueExW").Call(uintptr(key), uintptr(unsafe.Pointer(utf(name))), 0, syscall.REG_SZ, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	if code != 0 {
		t.Fatal(syscall.Errno(code))
	}
}

func TestLegacyOrphanRegistration(t *testing.T) {
	for _, view := range []uint32{syscall.KEY_WOW64_64KEY, syscall.KEY_WOW64_32KEY} {
		for _, scenario := range []string{"absent", "empty", "missing", "file", "directory", "relative", "empty-value", "missing-value", "uninstall-only", "complete", "bad-command", "link", "parent-link", "volume-root"} {
			t.Run(fmt.Sprintf("%d/%s", view, scenario), func(t *testing.T) {
				hive := orphanRegistryFixture(t, view)
				root := filepath.Join(t.TempDir(), "旧版 ScholarSeed")
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
				switch scenario {
				case "missing":
					if err := os.Remove(root); err != nil {
						t.Fatal(err)
					}
				case "file":
					if err := os.WriteFile(filepath.Join(root, "ScholarSeed.exe"), []byte("preserve"), 0600); err != nil {
						t.Fatal(err)
					}
				case "directory":
					if err := os.Mkdir(filepath.Join(root, "user-data"), 0700); err != nil {
						t.Fatal(err)
					}
				case "relative":
					root = `relative\ScholarSeed`
				case "empty-value":
					root = ""
				case "volume-root":
					root = filepath.VolumeName(root) + `\`
				case "link", "parent-link":
					target := root
					root = filepath.Join(t.TempDir(), "link")
					if err := os.Symlink(target, root); err != nil {
						t.Fatalf("symlink prerequisite: %v", err)
					}
					if scenario == "parent-link" {
						root = filepath.Join(root, "missing")
					}
				}
				if scenario != "absent" && scenario != "uninstall-only" {
					key := orphanCreateKey(t, hive, legacyInstallKey, view)
					if scenario != "missing-value" {
						orphanSetString(t, key, "InstallLocation", root)
					}
					orphanSetString(t, key, "KeepShortcuts", "true")
					syscall.RegCloseKey(key)
				}
				if scenario == "uninstall-only" || scenario == "complete" || scenario == "bad-command" {
					key := orphanCreateKey(t, hive, uninstallKey+legacyGUID, view)
					command := `"` + filepath.Join(root, legacyUninstaller) + `" /currentuser`
					if scenario == "bad-command" {
						command = "unexpected.exe"
					}
					orphanSetString(t, key, "UninstallString", command)
					syscall.RegCloseKey(key)
				}
				got, err := legacyRegistry(hive, view, "")
				switch scenario {
				case "absent", "empty", "missing":
					if err != nil || got != nil {
						t.Fatalf("orphan must allow fresh installation: %+v %v", got, err)
					}
				case "complete":
					if err != nil || got == nil || got.root != root {
						t.Fatalf("complete registration must remain migratable: %+v %v", got, err)
					}
				default:
					if err == nil {
						t.Fatalf("unsafe/incomplete state accepted: %+v", got)
					}
				}
				if scenario != "absent" && scenario != "uninstall-only" {
					var key syscall.Handle
					if err := syscall.RegOpenKeyEx(hive, utf(legacyInstallKey), 0, syscall.KEY_READ|view, &key); err != nil {
						t.Fatal("discovery removed registration", err)
					}
					defer syscall.RegCloseKey(key)
					value, err := registryString(key, "KeepShortcuts")
					if err != nil || value != "true" {
						t.Fatal("discovery mutated registration", value, err)
					}
				}
				if scenario == "file" {
					value, err := os.ReadFile(filepath.Join(root, "ScholarSeed.exe"))
					if err != nil || string(value) != "preserve" {
						t.Fatal("discovery mutated files", err)
					}
				}
			})
		}
	}
}

func TestLegacyRegistryReadFailureIsNotAbsence(t *testing.T) {
	if got, err := legacyRegistry(syscall.InvalidHandle, syscall.KEY_WOW64_64KEY, ""); err == nil || got != nil {
		t.Fatalf("invalid registry handle accepted: %+v %v", got, err)
	}
}

func TestLegacyOrphanAfterSamePathReinstall(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		"Update.exe": "fixture", "current/ScholarSeed.exe": "fixture",
		"current/sq.version": "<package><metadata><id>scholarseed</id></metadata></package>",
	} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := verifyRegisteredDirectory(root, "scholarseed"); err != nil {
		t.Fatal(err)
	}
	for _, view := range []uint32{syscall.KEY_WOW64_64KEY, syscall.KEY_WOW64_32KEY} {
		hive := orphanRegistryFixture(t, view)
		key := orphanCreateKey(t, hive, legacyInstallKey, view)
		orphanSetString(t, key, "InstallLocation", root)
		syscall.RegCloseKey(key)
		if got, err := legacyRegistry(hive, view, root); err != nil || got != nil {
			t.Fatalf("stale key blocked verified reinstall: %+v %v", got, err)
		}
		if _, err := legacyRegistry(hive, view, filepath.Join(root, "other")); err == nil {
			t.Fatal("unrelated current installation bypassed nonempty refusal")
		}
		key = orphanCreateKey(t, hive, uninstallKey+legacyGUID, view)
		orphanSetString(t, key, "UninstallString", `"`+filepath.Join(root, legacyUninstaller)+`" /currentuser`)
		syscall.RegCloseKey(key)
		if got, err := legacyRegistry(hive, view, root); err != nil || got == nil {
			t.Fatalf("current installation hid complete NSIS registration: %+v %v", got, err)
		}
	}
}
