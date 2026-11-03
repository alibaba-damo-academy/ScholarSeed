package handoff

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPublishedReadinessDoesNotHashButPreparationStillDoes(t *testing.T) {
	p, r, archives := fixture(t)
	root := t.TempDir()
	source := t.TempDir()
	for kind, data := range archives {
		if err := os.WriteFile(filepath.Join(source, kind+".zip"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.Prepare(root, r, func(c Component) (*os.File, error) { return os.Open(filepath.Join(source, c.Archive)) }); err != nil {
		t.Fatal(err)
	}
	component := r.Components[0]
	result, ready, err := p.publishedBootstrap(context.Background(), root, component, nil)
	if err != nil || !ready || !result.Reused {
		t.Fatalf("warm bootstrap: %v %v", ready, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ready, err = p.publishedBootstrap(ctx, root, component, nil); !errors.Is(err, context.Canceled) || ready {
		t.Fatalf("cancelled bootstrap: %v %v", ready, err)
	}

	var events []ComponentTiming
	p.observeTiming = func(event ComponentTiming) { events = append(events, event) }
	timing := p.timer(component, timingReadiness)
	ready, err = checkReadiness(p, root, component, timing)
	timing.finish(&err)
	if err != nil || !ready {
		t.Fatalf("readiness: %v %v", ready, err)
	}
	if events[0].Bytes != 0 || events[0].Metrics[timingHash].Calls != 0 {
		t.Fatal("readiness read payload bytes")
	}
	dir, _ := componentDirectory(root, component)
	entry := filepath.Join(dir, filepath.FromSlash(component.Entry))
	original, err := os.ReadFile(entry)
	if err != nil {
		t.Fatal(err)
	}
	changed := append([]byte(nil), original...)
	changed[0] ^= 1
	if err = os.WriteFile(entry, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if ready, err = checkReadiness(p, root, component, nil); err != nil || !ready {
		t.Fatalf("readiness must not claim full integrity: %v %v", ready, err)
	}
	if ready, err = checkReuse(p, root, component); err == nil || ready {
		t.Fatal("full verification accepted same-size corruption")
	}
	if _, err = p.Prepare(root, r, func(Component) (*os.File, error) { t.Fatal("corruption must not trigger extraction"); return nil, nil }); err == nil {
		t.Fatal("preparation accepted corruption")
	}
	if err = os.WriteFile(entry, append(original, 0), 0600); err != nil {
		t.Fatal(err)
	}
	if ready, err = checkReadiness(p, root, component, nil); err == nil || ready {
		t.Fatal("readiness accepted changed size")
	}
	if err = os.WriteFile(entry, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, ReceiptName), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if ready, err = checkReadiness(p, root, component, nil); err == nil || ready {
		t.Fatal("readiness accepted invalid receipt")
	}
	if ready, err = checkReadiness(p, t.TempDir(), component, nil); err != nil || ready {
		t.Fatalf("missing component: %v %v", ready, err)
	}
}

func TestInspectionRequestCannotCarryUpdateAuthority(t *testing.T) {
	request := Request{Schema: Schema, Operation: operationInspect, Root: t.TempDir()}
	if err := validateRequest(request); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Request){
		func(r *Request) { r.PackagePath = "payload.nupkg" },
		func(r *Request) { r.ReleaseEnvelope = []byte("{}") },
		func(r *Request) { r.RestartArgs = []string{"--remote-debugging-pipe"} },
		func(r *Request) { r.DiagnosticFile = "native-update.log" },
		func(r *Request) { r.Operation = "unknown" },
	} {
		changed := request
		change(&changed)
		if err := validateRequest(changed); err == nil {
			t.Fatal("inspection accepted update inputs")
		}
	}
}
