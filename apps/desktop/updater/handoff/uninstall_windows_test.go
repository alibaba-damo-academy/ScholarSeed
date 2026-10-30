package handoff

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestLegacyCacheCleanup(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ScholarSeedUpdates")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"handoff.exe", "request-12345678-1234-1234-1234-123456789012.json", "scholarseed-0.2.0-full.nupkg"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cleanCache(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("cache retained: %v", err)
	}
	if err := cleanCache(root); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyCachePreservesUnknownAndBusyFiles(t *testing.T) {
	for _, busy := range []bool{false, true} {
		root := t.TempDir()
		filename := filepath.Join(root, "handoff.exe")
		if err := os.WriteFile(filename, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		if busy {
			ptr, _ := syscall.UTF16PtrFromString(filename)
			handle, err := syscall.CreateFile(ptr, syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(handle)
		} else {
			if err := os.WriteFile(filepath.Join(root, "user.txt"), []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := cleanCache(root); err == nil {
			t.Fatal("unsafe cleanup accepted")
		}
		if _, err := os.Stat(filename); err != nil {
			t.Fatal("partially removed cache", err)
		}
	}
}

func TestLegacyCacheRejectsHardlinks(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "handoff.exe")); err != nil {
		t.Fatal(err)
	}
	if err := cleanCache(root); err == nil {
		t.Fatal("hardlink accepted")
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "keep" {
		t.Fatal("outside changed", err)
	}
}

func TestLegacyCacheRejectsReparseRoot(t *testing.T) {
	outside := t.TempDir()
	file := filepath.Join(outside, "handoff.exe")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "ScholarSeedUpdates")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink permission unavailable: %v", err)
	}
	if err := cleanCache(link); err == nil {
		t.Fatal("reparse root accepted")
	}
	if raw, err := os.ReadFile(file); err != nil || string(raw) != "keep" {
		t.Fatal("outside changed", err)
	}
}
