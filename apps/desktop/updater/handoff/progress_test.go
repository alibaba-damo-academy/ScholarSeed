package handoff

import (
	"os"
	"path/filepath"
	"testing"
)

func TestComponentProgressColdReuseAndFailure(t *testing.T) {
	p, runtime, archives := fixture(t)
	var events []ComponentProgress
	p.observeProgress = func(event ComponentProgress) { events = append(events, event) }
	root, source := t.TempDir(), t.TempDir()
	for kind, archive := range archives {
		if err := os.WriteFile(filepath.Join(source, kind+".zip"), archive, 0600); err != nil {
			t.Fatal(err)
		}
	}
	open := func(c Component) (*os.File, error) { return os.Open(filepath.Join(source, c.Archive)) }
	if _, err := p.Prepare(root, runtime, open); err != nil {
		t.Fatal(err)
	}
	for _, c := range runtime.Components {
		var phases []string
		for _, event := range events {
			if event.Kind != c.Kind {
				continue
			}
			phases = append(phases, event.Phase)
			if event.TotalBytes != c.ExpandedBytes || event.TotalFiles != len(c.Files) || event.Bytes > event.TotalBytes || event.Files > event.TotalFiles {
				t.Fatal(event)
			}
			if event.Phase == "complete" && (event.Bytes != event.TotalBytes || event.Files != event.TotalFiles) {
				t.Fatal(event)
			}
		}
		if len(phases) < 4 || phases[0] != "checking" || phases[1] != "extracting" || phases[len(phases)-2] != "publishing" || phases[len(phases)-1] != "complete" {
			t.Fatal(phases)
		}
	}
	events = nil
	if _, err := p.Prepare(root, runtime, open); err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Phase != "checking" && event.Phase != "reused" {
			t.Fatal(event)
		}
	}
	events = nil
	runtime.Components[0].ArchiveSHA256 = Hash([]byte("invalid"))
	if _, err := p.Prepare(t.TempDir(), runtime, open); err == nil {
		t.Fatal("accepted invalid archive")
	}
	for _, event := range events {
		if event.Phase == "complete" || event.Phase == "reused" {
			t.Fatal("failed preparation reported complete")
		}
	}
}
