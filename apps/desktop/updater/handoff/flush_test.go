package handoff

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

type gatedFlushFile struct {
	started  chan struct{}
	release  chan struct{}
	syncErr  error
	closeErr error
	closed   atomic.Int32
	synced   atomic.Int32
}

func (f *gatedFlushFile) Sync() error {
	f.synced.Add(1)
	if f.started != nil {
		f.started <- struct{}{}
	}
	if f.release != nil {
		<-f.release
	}
	return f.syncErr
}
func (f *gatedFlushFile) Close() error { f.closed.Add(1); return f.closeErr }

func TestExtractionFlushBatchesWithoutDroppingSyncOrLeakingFiles(t *testing.T) {
	for _, workers := range []int{0, 2, 4} {
		t.Run(fmt.Sprint(workers), func(t *testing.T) {
			p := newExtractionFlush(workers, nil)
			var files []*gatedFlushFile
			for i := 0; i < p.limit; i++ {
				f := &gatedFlushFile{}
				files = append(files, f)
				if err := p.submit(flushJob{file: f}); err != nil {
					t.Fatal(err)
				}
				if i+1 < p.limit && files[0].synced.Load() != 0 {
					t.Fatal("flush overlapped batch creation")
				}
			}
			for _, f := range files {
				if f.synced.Load() != 1 || f.closed.Load() != 1 {
					t.Fatal("batch did not drain before next creation")
				}
			}
			last := &gatedFlushFile{}
			if err := p.submit(flushJob{file: last}); err != nil {
				t.Fatal(err)
			}
			if err := p.finish(); err != nil {
				t.Fatal(err)
			}
			if last.synced.Load() != 1 || last.closed.Load() != 1 {
				t.Fatal("tail batch leaked")
			}
		})
	}
}

func TestExtractionFlushDrainsFailureAndPartialBatch(t *testing.T) {
	for _, count := range []int{3, 7} {
		p := newExtractionFlush(2, nil)
		failure := errors.New("flush failure")
		var files []*gatedFlushFile
		for i := 0; i < count; i++ {
			f := &gatedFlushFile{syncErr: failure}
			files = append(files, f)
			_ = p.submit(flushJob{file: f})
		}
		if err := p.finish(); !errors.Is(err, failure) {
			t.Fatal("flush failure lost", err)
		}
		for _, f := range files {
			if f.closed.Load() != 1 {
				t.Fatal("failed batch leaked or double closed")
			}
		}
	}
}

func TestFlushPipelineBoundedAndDrained(t *testing.T) {
	for _, workers := range []int{2, 4} {
		t.Run(fmt.Sprint(workers), func(t *testing.T) {
			started, release := make(chan struct{}, 32), make(chan struct{})
			p := newFlushPipeline(workers, nil)
			var files []*gatedFlushFile
			for i := 0; i < workers; i++ {
				f := &gatedFlushFile{started: started, release: release}
				files = append(files, f)
				if err := p.submit(flushJob{file: f}); err != nil {
					t.Fatal(err)
				}
			}
			for i := 0; i < workers; i++ {
				<-started
			}
			for i := 0; i < workers*flushQueuePerWorker; i++ {
				f := &gatedFlushFile{release: release}
				files = append(files, f)
				if err := p.submit(flushJob{file: f}); err != nil {
					t.Fatal(err)
				}
			}
			if len(p.jobs) != cap(p.jobs) {
				t.Fatal("queue did not reach its bound")
			}
			finished := make(chan error, 1)
			go func() { finished <- p.finish() }()
			select {
			case <-finished:
				t.Fatal("finish returned before sync")
			default:
			}
			for _, f := range files {
				if f.closed.Load() != 0 {
					t.Fatal("closed before sync completed")
				}
			}
			close(release)
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
			for _, f := range files {
				if f.closed.Load() != 1 {
					t.Fatal("handle ownership lost")
				}
			}
			if p.peak > workers*(flushQueuePerWorker+1)+1 || p.pending != 0 {
				t.Fatal(p.peak, p.pending)
			}
		})
	}
}

func TestFlushPipelinePreservesSyncAndCloseErrors(t *testing.T) {
	for _, workers := range []int{0, 2, 4} {
		for _, phase := range []string{"sync", "close"} {
			t.Run(fmt.Sprintf("%d/%s", workers, phase), func(t *testing.T) {
				failure := errors.New("disk failure")
				f := &gatedFlushFile{}
				if phase == "sync" {
					f.syncErr = failure
				} else {
					f.closeErr = failure
				}
				p := newFlushPipeline(workers, nil)
				_ = p.submit(flushJob{file: f})
				if err := p.finish(); !errors.Is(err, failure) {
					t.Fatal(err)
				}
				if f.closed.Load() != 1 {
					t.Fatal("failed file not closed exactly once")
				}
				rejected := &gatedFlushFile{}
				if err := p.submit(flushJob{file: rejected}); !errors.Is(err, failure) {
					t.Fatal(err)
				}
				if rejected.closed.Load() != 1 {
					t.Fatal("rejected ownership leaked")
				}
			})
		}
	}
}

func TestFlushPreparationWaitsBeforeReceiptAndReuses(t *testing.T) {
	for _, workers := range []int{0, 2, 4} {
		t.Run(fmt.Sprint(workers), func(t *testing.T) {
			p, r, archives := fixture(t)
			root, source := t.TempDir(), t.TempDir()
			c := r.Components[0]
			if err := os.WriteFile(filepath.Join(source, c.Archive), archives[c.Kind], 0600); err != nil {
				t.Fatal(err)
			}
			open := func(c Component) (*os.File, error) { return os.Open(filepath.Join(source, c.Archive)) }
			var events []ComponentTiming
			p.observeTiming = func(event ComponentTiming) { events = append(events, event) }
			result, err := p.prepareComponentWithFlush(root, c, open, workers)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(result.Directory, ReceiptName)); err != nil {
				t.Fatal(err)
			}
			if events[0].Metrics[timingSync].Calls != int64(c.FileCount) || events[0].FlushWorkers != workers {
				t.Fatal(events)
			}
			if ok, err := checkReuse(p, root, c); err != nil || !ok {
				t.Fatal(ok, err)
			}
			// A late inventory size failure must drain previous jobs, publish
			// neither directory nor receipt, and release every staging handle.
			var buf bytes.Buffer
			z := zip.NewWriter(&buf)
			c.Files = nil
			c.ExpandedBytes = 0
			c.FileCount = 20
			c.Entry = "data/00"
			for i := 0; i < c.FileCount; i++ {
				name := fmt.Sprintf("data/%02d", i)
				raw := []byte(name)
				f, _ := z.Create(name)
				f.Write(raw)
				c.Files = append(c.Files, Member{Path: name, Size: int64(len(raw)), SHA256: Hash(raw)})
				c.ExpandedBytes += int64(len(raw))
			}
			z.Close()
			c.ArchiveBytes = int64(buf.Len())
			c.ArchiveSHA256 = Hash(buf.Bytes())
			c.Files[19].Size++
			if err := os.WriteFile(filepath.Join(source, c.Archive), buf.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			root = t.TempDir()
			if _, err := p.prepareComponentWithFlush(root, c, open, workers); err == nil {
				t.Fatal("invalid member published")
			}
			entries, err := os.ReadDir(filepath.Join(root, "runtime", c.Kind))
			if err != nil || len(entries) != 0 {
				t.Fatal("stage or receipt survived failure", entries, err)
			}
		})
	}
}

func TestReceiptNeverOverwritesExistingFile(t *testing.T) {
	name := filepath.Join(t.TempDir(), ReceiptName)
	if err := writeReceipt(name, []byte("complete")); err != nil {
		t.Fatal(err)
	}
	if err := writeReceipt(name, []byte("replacement")); err == nil {
		t.Fatal("receipt overwritten")
	}
	raw, err := os.ReadFile(name)
	if err != nil || string(raw) != "complete" {
		t.Fatal(string(raw), err)
	}
}
