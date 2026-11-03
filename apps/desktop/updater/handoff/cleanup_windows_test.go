package handoff

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRuntimeCleanup(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	for i := range 12 {
		dir := filepath.Join(root, fmt.Sprint(i), "nested")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		for j := range 30 {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprint(j)), []byte("runtime"), 0400); err != nil {
				t.Fatal(err)
			}
		}
	}
	n, err := cleanRuntimeTree(context.Background(), root)
	if err != nil || n != 360 {
		t.Fatal(n, err)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("runtime retained", err)
	}
}

func TestInstalledRuntimeCleanupScope(t *testing.T) {
	for _, valid := range []bool{false, true} {
		t.Run(fmt.Sprint(valid), func(t *testing.T) {
			root := t.TempDir()
			current := filepath.Join(root, "current")
			runtime := filepath.Join(root, RuntimeStoreDirectory)
			for _, dir := range []string{current, runtime} {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			user := filepath.Join(root, "user-data")
			member := filepath.Join(runtime, "component")
			for _, name := range []string{user, member} {
				if err := os.WriteFile(name, []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if valid {
				xml := `<package><metadata><id>scholarseed</id><version>0.2.0-build.202610200001</version></metadata></package>`
				if err := os.WriteFile(filepath.Join(current, "sq.version"), []byte(xml), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := cleanInstalledRuntime(current)
			if valid {
				if err != nil {
					t.Fatal(err)
				}
				if _, err = os.Stat(runtime); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("runtime retained", err)
				}
				if err = cleanInstalledRuntime(current); err != nil {
					t.Fatal("absent runtime refused", err)
				}
			} else {
				if err == nil {
					t.Fatal("unregistered installation accepted")
				}
				if _, err = os.Stat(member); err != nil {
					t.Fatal("unqualified runtime changed", err)
				}
			}
			if data, err := os.ReadFile(user); err != nil || string(data) != "preserve" {
				t.Fatal("user data changed", err)
			}
		})
	}
}

func TestRuntimeCleanupWideDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	const count = cleanupBatch*3 + 1
	for i := range count {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprint(i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := cleanRuntimeTree(context.Background(), root); err != nil || n != count {
		t.Fatal(n, err)
	}
}

func TestRuntimeCleanupRefusesRedirectedAncestors(t *testing.T) {
	outside := t.TempDir()
	runtime := filepath.Join(outside, "runtime")
	if err := os.Mkdir(runtime, 0700); err != nil {
		t.Fatal(err)
	}
	member := filepath.Join(runtime, "preserve")
	if err := os.WriteFile(member, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "redirected")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink capability unavailable: %v", err)
	}
	if _, err := cleanRuntimeTree(context.Background(), filepath.Join(link, "runtime")); err == nil {
		t.Fatal("redirected ancestor accepted")
	}
	if _, err := os.Stat(member); err != nil {
		t.Fatal("external runtime changed", err)
	}
}

func TestRuntimeCleanupRefusesFileRoot(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "runtime")
	if err := os.WriteFile(filename, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := cleanRuntimeTree(context.Background(), filename); err == nil {
		t.Fatal("regular file accepted as runtime root")
	}
	if data, err := os.ReadFile(filename); err != nil || string(data) != "preserve" {
		t.Fatal("file root changed", err)
	}
}

func TestRuntimeCleanupCancellationDrainsWorkers(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	for i := range cleanupBatch * 4 {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprint(i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := runtimeCleanup{ctx: ctx, cancel: cancel, slots: make(chan struct{}, cleanupWorkers-1)}
	finished := make(chan error, 1)
	go func() { finished <- c.remove(root, 0) }()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(time.Second * 10)
	defer timeout.Stop()
	for c.files.Load() == 0 {
		select {
		case err := <-finished:
			t.Fatalf("cleanup ended before cancellation: %v", err)
		case <-ticker.C:
		case <-timeout.C:
			cancel()
			<-finished
			t.Fatal("cleanup did not make progress")
		}
	}
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation not reported", err)
	}
	if len(c.slots) != 0 {
		t.Fatal("cleanup returned before workers drained")
	}
	// Directory handles reject rename until every worker has actually closed.
	if err := os.Rename(root, root+"-cancelled"); err != nil {
		t.Fatal("cleanup retained live directory handles", err)
	}
}

func TestRuntimeCleanupRefusesLinksAndBusyFiles(t *testing.T) {
	for _, kind := range []string{"hardlink", "symlink", "directory-symlink", "busy", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			leaf := filepath.Join(root, "leaf")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch kind {
			case "hardlink":
				if err := os.Link(outside, leaf); err != nil {
					t.Fatal(err)
				}
			case "symlink", "directory-symlink":
				target := outside
				if kind == "directory-symlink" {
					target = filepath.Dir(outside)
				}
				if err := os.Symlink(target, leaf); err != nil {
					t.Skipf("symlink capability unavailable: %v", err)
				}
			default:
				if err := os.WriteFile(leaf, []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "busy" {
					name, _ := syscall.UTF16PtrFromString(leaf)
					h, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, 0, 0)
					if err != nil {
						t.Fatal(err)
					}
					defer syscall.CloseHandle(h)
				} else {
					cancel()
				}
			}
			if _, err := cleanRuntimeTree(ctx, root); err == nil {
				t.Fatal("unsafe cleanup succeeded")
			}
			for _, name := range []string{outside, leaf} {
				if _, err := os.Lstat(name); err != nil {
					t.Fatal("protected entry deleted", name, err)
				}
			}
		})
	}
}

// Opt-in throughput experiment; never touches an existing installation.
func TestRuntimeCleanupThroughput(t *testing.T) {
	if os.Getenv("SCHOLARSEED_CLEANUP_BENCHMARK") != "1" {
		t.Skip("opt-in filesystem throughput experiment")
	}
	for _, parallel := range []bool{false, true} {
		root := filepath.Join(t.TempDir(), "runtime")
		for i := range 80 {
			dir := filepath.Join(root, fmt.Sprint(i))
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			for j := range 250 {
				if err := os.WriteFile(filepath.Join(dir, fmt.Sprint(j)), []byte("runtime fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			}
		}
		start := time.Now()
		var err error
		if parallel {
			_, err = cleanRuntimeTree(context.Background(), root)
		} else {
			err = os.RemoveAll(root)
		}
		t.Logf("parallel=%v files=20000 elapsed=%s error=%v", parallel, time.Since(start), err)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestRuntimeCleanupInstalledCopy(t *testing.T) {
	source := os.Getenv("SCHOLARSEED_CLEANUP_SOURCE")
	if source == "" {
		t.Skip("requires an explicit read-only runtime source")
	}
	modes := []bool{false, true}
	updater := os.Getenv("SCHOLARSEED_CLEANUP_UPDATER")
	if updater != "" {
		modes = []bool{false}
	}
	for _, parallel := range modes {
		root := filepath.Join(t.TempDir(), "runtime")
		count := 0
		err := filepath.WalkDir(source, func(name string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(source, name)
			if err != nil {
				return err
			}
			if relative == ".archives" {
				return filepath.SkipDir
			}
			target := filepath.Join(root, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0700)
			}
			info, err := entry.Info()
			if err != nil || !info.Mode().IsRegular() {
				return errors.Join(err, fmt.Errorf("source is not a regular file: %s", name))
			}
			in, err := os.Open(name)
			if err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				in.Close()
				return err
			}
			_, copyErr := io.Copy(out, in)
			count++
			return errors.Join(copyErr, in.Close(), out.Close())
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("copy ready parallel=%v files=%d", parallel, count)
		start := time.Now()
		if updater != "" {
			// Framework throughput probe only: a unique fake application identity
			// and task-owned root keep the user's registration and shortcuts safe.
			current := filepath.Join(filepath.Dir(root), "current")
			if err := os.Mkdir(current, 0700); err != nil {
				t.Fatal(err)
			}
			manifest := `<package><metadata><id>scholarseed-cleanup-benchmark</id><version>0.2.0</version><title>Cleanup benchmark</title><authors>test</authors><mainExe>MissingHook.exe</mainExe><os>win</os><rid>win-x64</rid></metadata></package>`
			if err := os.WriteFile(filepath.Join(current, "sq.version"), []byte(manifest), 0600); err != nil {
				t.Fatal(err)
			}
			updaterBytes, readErr := os.ReadFile(updater)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if err := os.WriteFile(filepath.Join(filepath.Dir(root), "Update.exe"), updaterBytes, 0600); err != nil {
				t.Fatal(err)
			}
			log := filepath.Join(t.TempDir(), "framework.log")
			command := exec.Command(updater, "--silent", "--rootDir", filepath.Dir(root), "--log", log, "uninstall")
			output, runErr := command.CombinedOutput()
			err = runErr
			t.Logf("official updater: %s error=%v", output, err)
			if raw, readErr := os.ReadFile(log); readErr == nil {
				t.Logf("framework log:\n%s", raw)
			}
			if _, remains := os.Stat(root); !errors.Is(remains, os.ErrNotExist) {
				t.Fatal("official updater left runtime", remains)
			}
		} else if parallel {
			_, err = cleanRuntimeTree(context.Background(), root)
		} else {
			err = os.RemoveAll(root)
		}
		t.Logf("installed-copy parallel=%v files=%d elapsed=%s error=%v", parallel, count, time.Since(start), err)
		if err != nil {
			t.Fatal(err)
		}
	}
}
