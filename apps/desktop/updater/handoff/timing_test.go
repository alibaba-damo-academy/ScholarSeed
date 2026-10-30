package handoff

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPreparationTimingsObserveColdReuseAndFailure(t *testing.T) {
	p, runtime, archives := fixture(t)
	var events []ComponentTiming
	p.observeTiming = func(event ComponentTiming) { events = append(events, event) }
	root, source := t.TempDir(), t.TempDir()
	for kind, archive := range archives {
		if err := os.WriteFile(filepath.Join(source, kind+".zip"), archive, 0600); err != nil {
			t.Fatal(err)
		}
	}
	opens := 0
	open := func(c Component) (*os.File, error) { opens++; return os.Open(filepath.Join(source, c.Archive)) }
	if _, err := p.Prepare(root, runtime, open); err != nil {
		t.Fatal(err)
	}
	if len(events) != len(runtime.Components) {
		t.Fatal(events)
	}
	for i, event := range events {
		if event.Status != "passed" || event.Operation != timingPrepare || event.Kind != runtime.Components[i].Kind || event.Files != 1 || event.Bytes != runtime.Components[i].ExpandedBytes {
			t.Fatal(event)
		}
		if event.Metrics[timingHash].Calls != 0 {
			t.Fatal("component extraction hashed individual members", event)
		}
		for _, phase := range []string{timingArchive, timingPaths, timingDirectories, timingDirectoryPin, timingFileCreate, timingExtract, timingRead, timingWrite, timingSync, timingClose, timingPublish} {
			metric, exists := event.Metrics[phase]
			if !exists || metric.Calls == 0 || metric.ElapsedMS < 0 || metric.ElapsedMS > event.ElapsedMS {
				t.Fatalf("%s: %+v", phase, event)
			}
		}
	}
	events = nil
	if _, err := p.Prepare(root, runtime, open); err != nil {
		t.Fatal(err)
	}
	if opens != len(runtime.Components) {
		t.Fatal("timing changed reuse")
	}
	for _, event := range events {
		if event.Status != "reused" || event.Files != 0 || event.Metrics[timingExtract].Calls != 0 {
			t.Fatal(event)
		}
	}
	events = nil
	runtime.Components[0].ArchiveSHA256 = Hash([]byte("bad"))
	if _, err := p.Prepare(t.TempDir(), runtime, open); err == nil {
		t.Fatal("digest failure suppressed")
	}
	if len(events) != 1 || events[0].Status != "failed" || events[0].Metrics[timingArchive].Calls != 1 {
		t.Fatal(events)
	}
}

func TestTimingObserverIsNotPolicyAndWorkerStatusRetainsDiagnostics(t *testing.T) {
	p := testPolicy()
	before, _ := json.Marshal(p)
	var events []ComponentTiming
	p.observeTiming = func(event ComponentTiming) { events = append(events, event) }
	after, _ := json.Marshal(p)
	if string(before) != string(after) {
		t.Fatal("observer changed trust policy")
	}
	timer := p.timer(Component{Kind: "python", Version: "1-r1"}, timingPrepare)
	end := timer.start(timingSync)
	err := errors.New("failure")
	timer.finish(&err)
	end()
	if events[0].Status != "failed" || events[0].Metrics[timingSync].Calls != 1 {
		t.Fatal(events)
	}
	file, err := os.CreateTemp(t.TempDir(), "status")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := writeWorkerStatus(file, workerStatus{Nonce: "test-nonce", Event: "complete", Timings: events}); err != nil {
		t.Fatal(err)
	}
	state, err := readWorkerStatus(file, "test-nonce")
	if err != nil || len(state.Timings) != 1 || state.Timings[0].Metrics[timingSync].Calls != 1 {
		t.Fatalf("%+v %v", state, err)
	}
	if _, err := readWorkerStatus(file, "wrong-nonce"); err == nil {
		t.Fatal("diagnostics bypassed nonce")
	}
}
