package handoff

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

const (
	timingReadiness    = "readiness"
	timingAuthorize    = "authorize"
	timingCommit       = "commit"
	timingAdmission    = "admission"
	timingTools        = "application_tools"
	timingBootstrap    = "bootstrap"
	timingRequest      = "request"
	timingReceipt      = "receipt"
	timingInventory    = "inventory"
	timingEntry        = "entry"
	timingLineage      = "lineage"
	timingSignature    = "signature"
	timingPrincipal    = "principal"
	timingCoordinator  = "coordinator"
	timingIdentity     = "identity"
	timingManifest     = "manifest"
	timingLock         = "lock"
	timingPrefix       = "[component-timing]"
	timingPrepare      = "prepare"
	timingPreflight    = "preflight"
	timingDownload     = "download"
	timingReuse        = "reuse"
	timingPaths        = "paths"
	timingArchive      = "archive"
	timingDirectories  = "directories"
	timingDirectoryPin = "directory_pin"
	timingFileCreate   = "file_create"
	timingPermissions  = "permissions"
	timingCopy         = "read_write_hash"
	timingSync         = "sync"
	timingClose        = "close"
	timingPublish      = "publish"
	timingExtract      = "extract"
	timingRead         = "read"
	timingWrite        = "write"
	timingHash         = "hash"
	timingHeaders      = "headers"
	timingFlushWait    = "flush_wait"
	timingFlushDrain   = "flush_drain"
	timingFlushBatch   = "flush_batch"
)

// ComponentTiming is diagnostic evidence only, never receipt or authorization
// input. Inner metrics are accumulated in memory, not logged per archive member.
type ComponentTiming struct {
	FlushWorkers int                     `json:"flush_workers,omitempty"`
	FlushPeak    int                     `json:"flush_peak,omitempty"`
	Kind         string                  `json:"kind"`
	Version      string                  `json:"version"`
	Operation    string                  `json:"operation"`
	PID          int                     `json:"pid"`
	Status       string                  `json:"status"`
	Phase        string                  `json:"last_phase"`
	ElapsedMS    float64                 `json:"elapsed_ms"`
	Files        int64                   `json:"files"`
	Bytes        int64                   `json:"bytes"`
	Metrics      map[string]TimingMetric `json:"metrics"`
}
type TimingMetric struct {
	Calls     int64   `json:"calls"`
	ElapsedMS float64 `json:"elapsed_ms"`
}
type componentTimer struct {
	event   ComponentTiming
	started time.Time
	observe func(ComponentTiming)
	pending map[int]func()
	serial  int
}

func (policy Policy) WithTimingObserver(observe func(ComponentTiming)) Policy {
	policy.observeTiming = func(event ComponentTiming) {
		writeTimings([]ComponentTiming{event})
		if observe != nil {
			observe(event)
		}
	}
	return policy
}

func (p Policy) timer(c Component, operation string) *componentTimer {
	return &componentTimer{event: ComponentTiming{Kind: c.Kind, Version: c.Version,
		Operation: operation, PID: os.Getpid(), Status: "passed", Metrics: map[string]TimingMetric{}},
		started: time.Now(), observe: p.observeTiming, pending: map[int]func(){}}
}
func (t *componentTimer) start(phase string) func() {
	if t == nil {
		return func() {}
	}
	t.event.Phase = phase
	start := time.Now()
	t.serial++
	id := t.serial
	ended := false
	finish := func() {
		if ended {
			return
		}
		ended = true
		delete(t.pending, id)
		value := t.event.Metrics[phase]
		value.Calls++
		value.ElapsedMS += float64(time.Since(start)) / float64(time.Millisecond)
		t.event.Metrics[phase] = value
	}
	t.pending[id] = finish
	return finish
}
func (t *componentTimer) finish(err *error) {
	for _, finish := range t.pending {
		finish()
	}
	t.event.ElapsedMS = float64(time.Since(t.started)) / float64(time.Millisecond)
	if *err != nil {
		t.event.Status = "failed"
	}
	if t.observe != nil {
		t.observe(t.event)
	} else {
		writeTimings([]ComponentTiming{t.event})
	}
}
func writeTimings(events []ComponentTiming) {
	for _, event := range events {
		raw, err := json.Marshal(event)
		if err == nil {
			_, _ = fmt.Fprintf(os.Stderr, "%s %s\n", timingPrefix, raw)
		}
	}
}

// Preserve streaming I/O and hashing; measurements never buffer file contents.
type timedReader struct {
	io.Reader
	timing *componentTimer
}

func (r timedReader) Read(bytes []byte) (int, error) {
	end := r.timing.start(timingRead)
	defer end()
	return r.Reader.Read(bytes)
}

type timedWriter struct {
	io.Writer
	timing *componentTimer
	phase  string
}

func (w timedWriter) Write(bytes []byte) (int, error) {
	end := w.timing.start(w.phase)
	defer end()
	return w.Writer.Write(bytes)
}
