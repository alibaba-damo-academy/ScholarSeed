package handoff

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func texCacheFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	current := filepath.Join(root, "current")
	cache := joinPath(root, texCacheRelative)
	for _, dir := range []string{current, cache, joinPath(root, "runtime/texlive/2026-r3"), joinPath(root, "runtime/.archives")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for file, data := range map[string]string{
		filepath.Join(current, "sq.version"):           `<package><metadata><id>scholarseed</id><version>0.2.0-build.202610211524</version></metadata></package>`,
		joinPath(root, "runtime/texlive/2026-r3/keep"): "toolchain",
		joinPath(root, "runtime/.archives/keep"):       "archive",
		filepath.Join(root, "user-data"):               "user",
	} {
		if err := os.WriteFile(file, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{strings.Repeat("a", 64), "2026-r3", "arbitrary-old-cache"} {
		dir := filepath.Join(cache, name, "texmf-var")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "data"), []byte("cache"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return current, cache
}

func TestUpdateTexCacheReset(t *testing.T) {
	current, cache := texCacheFixture(t)
	if err := cleanInstalledTexCache(current); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{cache, filepath.Join(filepath.Dir(cache), texCacheRetired)} {
		if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("cache retained: %s %v", name, err)
		}
	}
	for _, name := range []string{"runtime/texlive/2026-r3/keep", "runtime/.archives/keep", "user-data", "current/sq.version"} {
		if _, err := os.Stat(joinPath(filepath.Dir(current), name)); err != nil {
			t.Fatal("outside cache changed", err)
		}
	}
	if err := cleanInstalledTexCache(current); err != nil {
		t.Fatal("absent cache not idempotent", err)
	}
	// Ordinary creation after reset has no tombstone or locked handle in its way.
	if err := os.MkdirAll(filepath.Join(cache, "2026-r3"), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateTexCachePreflightPreservesWholeTree(t *testing.T) {
	for _, kind := range []string{"busy-file", "busy-directory", "readonly", "hardlink", "file-root", "cancelled", "wrong-current", "unregistered"} {
		t.Run(kind, func(t *testing.T) {
			current, cache := texCacheFixture(t)
			member := filepath.Join(cache, "2026-r3", "texmf-var", "data")
			switch kind {
			case "busy-file", "busy-directory":
				name := member
				if kind == "busy-directory" {
					name = filepath.Dir(member)
				}
				ptr, _ := syscall.UTF16PtrFromString(name)
				h, err := syscall.CreateFile(ptr, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer syscall.CloseHandle(h)
			case "readonly":
				if err := os.Chmod(member, 0400); err != nil {
					t.Fatal(err)
				}
				defer os.Chmod(member, 0600)
			case "hardlink":
				if err := os.Link(member, filepath.Join(filepath.Dir(current), "outside")); err != nil {
					t.Fatal(err)
				}
			case "file-root":
				if err := os.RemoveAll(cache); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(cache, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			case "wrong-current":
				current = filepath.Dir(current)
			case "unregistered":
				if err := os.Remove(filepath.Join(current, "sq.version")); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			if kind == "cancelled" {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				_, err = resetTexCache(ctx, cache, filepath.Join(filepath.Dir(cache), texCacheRetired))
			} else {
				err = cleanInstalledTexCache(current)
			}
			if err == nil {
				t.Fatal("unsafe cleanup accepted")
			}
			if kind != "file-root" {
				if _, e := os.Lstat(cache); errors.Is(e, os.ErrNotExist) {
					cache = filepath.Join(filepath.Dir(cache), texCacheRetired)
				}
				if data, e := os.ReadFile(filepath.Join(cache, strings.Repeat("a", 64), "texmf-var", "data")); e != nil || string(data) != "cache" {
					t.Fatal("preflight partly deleted cache", e)
				}
			} else if data, e := os.ReadFile(cache); e != nil || string(data) != "keep" {
				t.Fatal("file root modified", e)
			}
		})
	}
}

func TestUpdateTexCacheLongPathAndRetiredRecovery(t *testing.T) {
	current, cache := texCacheFixture(t)
	nested := filepath.Join(cache, strings.Repeat("a", 64), strings.Repeat("b", 100), strings.Repeat("c", 100))
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "cache"), []byte("long"), 0600); err != nil {
		t.Fatal(err)
	}
	retired := filepath.Join(filepath.Dir(cache), texCacheRetired)
	if err := os.MkdirAll(retired, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(retired, "interrupted"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := cleanInstalledTexCache(current); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cache); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestUpdateTexCacheRejectsJunction(t *testing.T) {
	for _, location := range []string{"ancestor", "leaf"} {
		t.Run(location, func(t *testing.T) {
			current, cache := texCacheFixture(t)
			outside := t.TempDir()
			sentinel := filepath.Join(outside, "keep")
			if err := os.WriteFile(sentinel, []byte("outside"), 0600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(cache, "redirect")
			if location == "ancestor" {
				if err := os.RemoveAll(filepath.Dir(cache)); err != nil {
					t.Fatal(err)
				}
				link = filepath.Dir(cache)
			}
			if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
				t.Fatalf("junction setup: %v %s", err, output)
			}
			defer os.Remove(link)
			if err := cleanInstalledTexCache(current); err == nil {
				t.Fatal("junction followed")
			}
			if raw, err := os.ReadFile(sentinel); err != nil || string(raw) != "outside" {
				t.Fatal("outside changed", err)
			}
		})
	}
}

func TestUpdateTexCacheBudget(t *testing.T) {
	current, cache := texCacheFixture(t)
	for i := 0; i < texCacheLimit; i++ {
		if err := os.WriteFile(filepath.Join(cache, fmt.Sprint(i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cleanInstalledTexCache(current); err == nil {
		t.Fatal("unbounded cleanup")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(cache), texCacheRetired, "0")); err != nil {
		t.Fatal("preflight deletion", err)
	}
}

func TestUpdateTexCacheBusyRootAndRetiredRetry(t *testing.T) {
	current, cache := texCacheFixture(t)
	pin, err := pinDirectorySharing(cache, syscall.FILE_LIST_DIRECTORY, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE)
	if err != nil {
		t.Fatal(err)
	}
	if err = cleanInstalledTexCache(current); err == nil {
		t.Fatal("active root pin ignored")
	}
	if err = pin.Close(); err != nil {
		t.Fatal(err)
	}
	retired := filepath.Join(filepath.Dir(cache), texCacheRetired)
	if err = os.Mkdir(retired, 0700); err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(retired, "old")
	if err = os.WriteFile(retained, []byte("old"), 0400); err != nil {
		t.Fatal(err)
	}
	if err = cleanInstalledTexCache(current); err == nil {
		t.Fatal("readonly retirement accepted")
	}
	if _, err = os.Stat(cache); err != nil {
		t.Fatal("active namespace changed while retirement blocked", err)
	}
	if err = os.Chmod(retained, 0600); err != nil {
		t.Fatal(err)
	}
	if err = cleanInstalledTexCache(current); err != nil {
		t.Fatal("later update could not retry", err)
	}
	if err = os.MkdirAll(cache, 0700); err != nil {
		t.Fatal(err)
	}
	if err = cleanInstalledTexCache(current); err != nil {
		t.Fatal("empty namespace refused", err)
	}
}
