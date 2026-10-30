package handoff

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const diagnosticRequest = "request-12345678-1234-1234-1234-123456789012.json"

func diagnosticRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, restartLogDirectory), 0700); err != nil {
		t.Fatal(err)
	}
	return root
}

func diagnosticLogPath(root string) string {
	return filepath.Join(root, restartLogDirectory, restartLogName)
}

func waitDiagnosticFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("diagnostic subprocess did not produce %s", filepath.Base(path))
}

// An actual parent process launches the coordinator fixture and then exits.
// The root test releases the fixture only after that parent's Wait completes.
func TestRestartDiagnosticsProcess(t *testing.T) {
	if len(os.Args) < 5 || os.Args[2] != "--" {
		return
	}
	mode, root := os.Args[3], os.Args[4]
	if mode == "parent" {
		child := exec.Command(os.Args[0], "-test.run=^TestRestartDiagnosticsProcess$", "--", "coordinator", root)
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		defer child.Process.Release()
		waitDiagnosticFile(t, filepath.Join(root, "ready"))
		return
	}
	if mode != "coordinator" {
		t.Fatal("invalid subprocess mode")
	}
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), diagnosticLogPath(root), "old", "new")
	if diagnostics.file == nil {
		t.Fatal("persistent diagnostics unavailable")
	}
	// The coordinator cannot rely on the old application's output pipe.
	os.Stderr.Close()
	if err := os.WriteFile(filepath.Join(root, "ready"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitDiagnosticFile(t, filepath.Join(root, "parent-exited"))
	err := restartUpdatedApplication("installed.exe", []string{"--user-data-dir=DO-NOT-LOG"}, func(string) error {
		return nil
	}, func(string, []string) (int, error) {
		return 1234, nil
	}, diagnostics)
	diagnostics.close()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "done"), nil, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRestartDiagnosticsSurviveParentExit(t *testing.T) {
	root := diagnosticRoot(t)
	parent := exec.Command(os.Args[0], "-test.run=^TestRestartDiagnosticsProcess$", "--", "parent", root)
	if output, err := parent.CombinedOutput(); err != nil {
		t.Fatalf("parent: %v %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(root, "parent-exited"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitDiagnosticFile(t, filepath.Join(root, "done"))
	raw, err := os.ReadFile(diagnosticLogPath(root))
	if err != nil {
		t.Fatal(err)
	}
	events := readRestartEvents(t, bytes.NewReader(raw))
	if len(events) != 4 || events[1].Event != "icon_refresh.notified" || events[3].Event != "application_restart.started" || events[3].ChildPID != 1234 {
		t.Fatalf("incomplete persisted events: %s", raw)
	}
	if bytes.Contains(raw, []byte("DO-NOT-LOG")) {
		t.Fatal("launch arguments leaked into diagnostics")
	}
}

func TestRestartDiagnosticsAppendExistingFile(t *testing.T) {
	root := diagnosticRoot(t)
	path := diagnosticLogPath(root)
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), diagnosticLogPath(root), "old", "new")
	defer diagnostics.close()
	if diagnostics.file == nil {
		t.Fatal("existing regular log was not opened for append")
	}
	diagnostics.record("fixture", time.Now(), 0, nil)
	if raw, err := os.ReadFile(path); err != nil || !bytes.HasPrefix(raw, []byte("keep\n{")) {
		t.Fatalf("existing log was not preserved: %s %v", raw, err)
	}
}

func TestRestartDiagnosticsOpenFailureDoesNotPreventLaunch(t *testing.T) {
	diagnostics := openRestartDiagnostics(filepath.Join(t.TempDir(), diagnosticRequest), filepath.Join(t.TempDir(), "missing", restartLogDirectory, restartLogName), "old", "new")
	defer diagnostics.close()
	launched := false
	err := restartUpdatedApplication("installed.exe", nil, func(string) error { return nil }, func(string, []string) (int, error) {
		launched = true
		return 1234, nil
	}, diagnostics)
	if err != nil || !launched {
		t.Fatalf("log creation blocked recovery: %v", err)
	}
}

func TestRestartDiagnosticsAreReadableBeforeLaunch(t *testing.T) {
	root := diagnosticRoot(t)
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), diagnosticLogPath(root), "old", "new")
	defer diagnostics.close()
	if diagnostics.file == nil {
		t.Fatal("persistent log unavailable")
	}
	err := restartUpdatedApplication("installed.exe", nil, func(string) error {
		return errors.New(strings.Repeat("x", restartErrorBytes*2))
	}, func(string, []string) (int, error) {
		raw, err := os.ReadFile(diagnosticLogPath(root))
		if err != nil {
			t.Fatal(err)
		}
		events := readRestartEvents(t, bytes.NewReader(raw))
		if len(events) != 3 || events[1].Event != "icon_refresh.failed" || len(events[1].Error) != restartErrorBytes || events[2].Event != "application_restart.start" {
			t.Fatalf("restart began before complete diagnostics: %+v", events)
		}
		return 1234, nil
	}, diagnostics)
	if err != nil {
		t.Fatal(err)
	}
}

func TestRestartDiagnosticsRefuseSymlink(t *testing.T) {
	root := diagnosticRoot(t)
	outside := filepath.Join(t.TempDir(), "keep")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, diagnosticLogPath(root)); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), diagnosticLogPath(root), "old", "new")
	defer diagnostics.close()
	if diagnostics.file != nil {
		t.Fatal("symlink target opened for writing")
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "keep" {
		t.Fatalf("outside file changed: %s %v", raw, err)
	}
}

func TestRestartDiagnosticsRefuseHardlink(t *testing.T) {
	root := diagnosticRoot(t)
	outside := filepath.Join(t.TempDir(), "keep")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, diagnosticLogPath(root)); err != nil {
		t.Fatal(err)
	}
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), diagnosticLogPath(root), "old", "new")
	defer diagnostics.close()
	if diagnostics.file != nil {
		t.Fatal("hardlink target opened for writing")
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "keep" {
		t.Fatalf("outside file changed: %s %v", raw, err)
	}
}

func TestRestartDiagnosticsRefuseRedirectedDirectory(t *testing.T) {
	root := diagnosticRoot(t)
	outside := t.TempDir()
	if err := os.Remove(filepath.Join(root, restartLogDirectory)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, restartLogDirectory)); err != nil {
		t.Skipf("directory symlink unavailable: %v", err)
	}
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), diagnosticLogPath(root), "old", "new")
	defer diagnostics.close()
	if diagnostics.file != nil {
		t.Fatal("redirected log directory accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, restartLogName)); !os.IsNotExist(err) {
		t.Fatalf("redirected directory was written: %v", err)
	}
}

func TestApplyDiagnosticPathFromDesktopProducer(t *testing.T) {
	producer, err := filepath.Abs("../../src/main/transfer.ts")
	if err != nil {
		t.Fatal(err)
	}
	script := `
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { transferRequest } = await import(pathToFileURL(process.argv[1]).href);
const application = resolve('installed/current');
const diagnosticFile = resolve('custom 书深/logs/native-update.log');
console.log(JSON.stringify(['apply', 'inspect', 'prepare', 'group'].map(operation =>
 transferRequest({operation, application, diagnosticFile}, resolve('installed')))));
`
	output, err := exec.Command("node", "--experimental-transform-types", "--input-type=module", "-e", script, producer).Output()
	if err != nil {
		t.Fatalf("Desktop diagnostic path producer: %v", err)
	}
	var requests []Request
	if err = json.Unmarshal(output, &requests); err != nil || len(requests) != 4 {
		t.Fatalf("invalid producer output: %s %v", output, err)
	}
	want, _ := filepath.Abs("custom 书深/logs/native-update.log")
	for _, request := range requests {
		if err = validateRequest(request); err != nil {
			t.Fatal(err)
		}
		if request.Operation == "apply" {
			if request.DiagnosticFile != want {
				t.Fatalf("custom Home changed: %q", request.DiagnosticFile)
			}
		} else if request.DiagnosticFile != "" {
			t.Fatal("diagnostic output escaped update scope")
		}
	}
}

func TestRestartDiagnosticsKeepBoundedTail(t *testing.T) {
	root := diagnosticRoot(t)
	path := diagnosticLogPath(root)
	data := []byte(strings.Repeat("old-record\n", restartLogMaxBytes/10+1) + "recent-record\n")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	diagnostics := openRestartDiagnostics(filepath.Join(root, diagnosticRequest), path, "old", "new")
	if diagnostics.file == nil {
		t.Fatal("log unavailable")
	}
	diagnostics.record(iconRefreshNotified, time.Now(), 0, nil)
	diagnostics.close()
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > restartLogMaxBytes || !bytes.Contains(raw, []byte("recent-record\n")) || !bytes.Contains(raw, []byte(`"event":"icon_refresh.notified"`)) {
		t.Fatalf("bounded append lost recent diagnostics: bytes=%d err=%v", len(raw), err)
	}
}
