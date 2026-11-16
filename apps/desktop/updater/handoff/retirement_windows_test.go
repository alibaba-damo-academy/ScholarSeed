package handoff

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

func TestRetirementProcess(t *testing.T) {
	if code := os.Getenv("SCHOLARSEED_RETIREMENT_TEST_EXIT"); code != "" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		value, _ := strconv.Atoi(code)
		os.Exit(value)
	}
}

func TestRetirementExitBarrier(t *testing.T) {
	for _, scenario := range []string{"success", "pending", "unknown", "failed"} {
		t.Run(scenario, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "书深 with spaces")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			image := filepath.Join(root, "Update.exe")
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			executable, err := os.ReadFile(self)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(image, executable, 0700); err != nil {
				t.Fatal(err)
			}
			if scenario == "unknown" {
				if err := os.WriteFile(filepath.Join(root, "user.txt"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			parent := exec.Command(image, "-test.run=^TestRetirementProcess$")
			parent.Dir = root
			if scenario == "pending" {
				parent = exec.Command(self, "-test.run=^TestRetirementProcess$")
			}
			code := "0"
			if scenario == "failed" {
				code = "7"
			}
			parent.Env = append(os.Environ(), "SCHOLARSEED_RETIREMENT_TEST_EXIT="+code)
			input, err := parent.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = parent.Start(); err != nil {
				t.Fatal(err)
			}
			defer parent.Process.Kill()
			defer input.Close()
			process, err := openProcessWaiter(uint32(parent.Process.Pid))
			if err != nil {
				t.Fatal(err)
			}
			defer process.Close()
			worker, err := startRetirement(root, process.(*windowsWaiter).handle)
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Process.Kill()
			if _, err = os.Stat(image); err != nil {
				t.Fatal("deleted before owner exited", err)
			}
			if err = os.Rename(root, root+"-swapped"); err == nil {
				t.Fatal("live retirement root could be swapped")
			}
			if scenario == "pending" {
				if err = os.Remove(image); err != nil {
					t.Fatal("official pending deletion", err)
				}
			}
			if err = input.Close(); err != nil {
				t.Fatal(err)
			}
			_ = parent.Wait()
			err = worker.Wait()
			if scenario == "success" || scenario == "pending" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err = os.Lstat(root); !os.IsNotExist(err) {
					t.Fatalf("root retained: %v", err)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe finalization reported success")
				}
				file := image
				if scenario == "unknown" {
					file = filepath.Join(root, "user.txt")
				}
				if _, err = os.Stat(file); err != nil {
					t.Fatal("protected residue changed", err)
				}
			}
		})
	}
}

func TestRetirementRejectsHardlinkedImage(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "Update.exe")); err != nil {
		t.Fatal(err)
	}
	process, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	if _, err = startRetirement(root, process.(*windowsWaiter).handle); err == nil {
		t.Fatal("hardlink accepted")
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "keep" {
		t.Fatal("outside changed", err)
	}
}

func TestRetirementRejectsUnrelatedParent(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := prepareRetirement(filepath.Join(root, "current")); err == nil {
		t.Fatal("unrelated parent accepted")
	}
}

func TestRetirementRejectsJunctions(t *testing.T) {
	for _, position := range []string{"root", "ancestor"} {
		t.Run(position, func(t *testing.T) {
			outside := t.TempDir()
			root := outside
			if position == "ancestor" {
				root = filepath.Join(outside, "install")
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
			}
			image := filepath.Join(root, "Update.exe")
			if err := os.WriteFile(image, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(t.TempDir(), "redirect")
			if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
				t.Fatalf("junction setup: %v %s", err, output)
			}
			defer os.Remove(link)
			target := link
			if position == "ancestor" {
				target = filepath.Join(link, "install")
			}
			process, err := openProcessWaiter(uint32(os.Getpid()))
			if err != nil {
				t.Fatal(err)
			}
			defer process.Close()
			if _, err = startRetirement(target, process.(*windowsWaiter).handle); err == nil {
				t.Fatal("junction accepted")
			}
			if raw, err := os.ReadFile(image); err != nil || string(raw) != "preserve" {
				t.Fatal("outside changed", err)
			}
		})
	}
}
