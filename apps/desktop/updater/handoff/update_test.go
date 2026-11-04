package handoff

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUpdatePresentationFinishesBeforeRestart(t *testing.T) {
	workerFailure := errors.New("component extraction failed")
	launchFailure := errors.New("launch denied")
	for _, scenario := range []struct {
		name    string
		outcome error
		launch  error
		recover bool
	}{
		{"success", nil, nil, true},
		{"worker-failed", workerFailure, nil, true},
		{"launch-failed", workerFailure, launchFailure, true},
		{"unconfirmed", &UpdateRecoveryError{Cause: workerFailure}, nil, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			open, launches, presentations := false, 0, 0
			err := presentUpdate(func(func(ComponentProgress)) (func() error, error) {
				if !scenario.recover {
					return nil, scenario.outcome
				}
				return func() error {
					if open {
						t.Fatal("restarted while modal presentation holds helper")
					}
					launches++
					return scenario.launch
				}, scenario.outcome
			}, func(run func(func(ComponentProgress)) error) error {
				open = true
				presentations++
				err := run(nil)
				open = false
				return err
			})
			if !errors.Is(err, scenario.outcome) || (scenario.launch != nil && !errors.Is(err, scenario.launch)) {
				t.Fatalf("lost outcome: %v", err)
			}
			wantLaunches, wantPresentations := 0, 1
			if scenario.recover {
				wantLaunches = 1
			}
			if scenario.launch != nil {
				wantPresentations = 2
			}
			if launches != wantLaunches || presentations != wantPresentations {
				t.Fatalf("launches=%d presentations=%d", launches, presentations)
			}
		})
	}
}

func TestUpdateFailureKeepsCommittedRecoveryNotice(t *testing.T) {
	for _, exited := range []bool{true, false} {
		failure := &UpdateRecoveryError{ProcessesExited: exited, Cause: errors.New("wait expired")}
		if !deferUpdateFailure(fmt.Errorf("coordinator: %w", failure)) {
			t.Fatal("committed recovery replaced by generic reopen advice")
		}
	}
	if deferUpdateFailure(nil) || deferUpdateFailure(errors.New("ordinary preparation failure")) {
		t.Fatal("ordinary failure incorrectly delegated")
	}
}

func testUpdateMessages() map[string]UpdateMessages {
	text := UpdateMessages{
		StartupMessages: StartupMessages{Title: "Updating", Brand: "ScholarSeed", Elapsed: "Waiting:",
			Preparing: "Preparing", Failed: "Failed", Exit: "Exit",
			Extracting: "Extracting {{name}}: {{percent}}% ({{count}} / {{total}} files)"},
		Checking: "Checking {{name}}", Publishing: "Publishing {{name}}", Ready: "{{name}} ready",
		Installing: "Installing", Restarting: "Restarting",
	}
	return map[string]UpdateMessages{"en": text, "zh": text}
}

func TestUpdateProgressStagesAndClampedBytes(t *testing.T) {
	text := testUpdateMessages()["en"]
	for _, tc := range []struct {
		phase    string
		bytes    int64
		want     string
		received int64
	}{
		{"checking", 0, "Checking TeX Live", 0},
		{"extracting", 50, "Extracting TeX Live: 50% (3 / 8 files)", 50},
		{"extracting", -1, "Extracting TeX Live: 0% (3 / 8 files)", 0},
		{"extracting", 200, "Extracting TeX Live: 100% (3 / 8 files)", 100},
		{"publishing", 100, "Publishing TeX Live", 0},
		{"reused", 100, "TeX Live ready", 0},
		{"complete", 100, "TeX Live ready", 0},
		{updateInstalling, 0, "Installing", 0},
		{updateRestarting, 0, "Restarting", 0},
	} {
		p := text.progress(ComponentProgress{Kind: "texlive", Phase: tc.phase, Bytes: tc.bytes, TotalBytes: 100, Files: 3, TotalFiles: 8})
		if p.Text != tc.want || p.Received != tc.received || (tc.phase != "extracting" && p.Total != 0) {
			t.Fatalf("%s: %+v", tc.phase, p)
		}
	}
	if p := text.progress(ComponentProgress{Phase: "extracting"}); p.Total != 0 || p.Received != 0 {
		t.Fatal(p)
	}
}

func TestUpdateMessagesRejectMissingLanguageAndParameters(t *testing.T) {
	if err := validateUpdateMessages(testUpdateMessages()); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(map[string]UpdateMessages){
		func(m map[string]UpdateMessages) { delete(m, "zh") },
		func(m map[string]UpdateMessages) { text := m["en"]; text.Installing = ""; m["en"] = text },
		func(m map[string]UpdateMessages) {
			text := m["en"]
			text.Extracting = "{{name}} {{percent}}"
			m["en"] = text
		},
	} {
		m := testUpdateMessages()
		mutate(m)
		if validateUpdateMessages(m) == nil {
			t.Fatal("invalid presentation accepted")
		}
	}
}

type progressWorker struct{ finished chan struct{} }

func (w progressWorker) Done() (bool, error)                { return false, nil }
func (w progressWorker) Wait(time.Duration) (uint32, error) { <-w.finished; return 7, nil }
func (w progressWorker) Terminate() error                   { return nil }
func (w progressWorker) Close() error                       { return nil }

func TestUpdateProgressCannotCompleteWorkerAndRequiresNonce(t *testing.T) {
	file, err := os.Create(filepath.Join(t.TempDir(), "status"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := os.Open(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	w := progressWorker{make(chan struct{})}
	progress := ComponentProgress{Kind: "texlive", Phase: "extracting", Bytes: 50, TotalBytes: 100}
	if err = writeWorkerStatus(file, workerStatus{Nonce: "foreign", Event: "progress", Progress: &progress}); err != nil {
		t.Fatal(err)
	}
	reported := make(chan ComponentProgress, 2)
	done := make(chan uint32, 1)
	go func() {
		code, _ := waitWorkerProgress(w, reader, "expected", true, WorkerWait, func(p ComponentProgress) { reported <- p })
		done <- code
	}()
	defer func() { close(w.finished); <-done }()
	select {
	case <-reported:
		t.Fatal("foreign progress accepted")
	case <-done:
		t.Fatal("progress completed worker")
	case <-time.After(3 * progressInterval):
	}
	if err = writeWorkerStatus(file, workerStatus{Nonce: "expected", Event: "progress", Progress: &progress}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-reported:
		if got != progress {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("update progress missing")
	}
	select {
	case <-done:
		t.Fatal("worker completion inferred from progress")
	default:
	}
	if err = writeWorkerStatus(file, workerStatus{Nonce: "expected", Event: "progress", Stage: updateInstalling}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-reported:
		if got.Kind != "application" || got.Phase != updateInstalling {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("private installation stage missing")
	}
}
