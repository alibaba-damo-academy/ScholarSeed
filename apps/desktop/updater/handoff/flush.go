package handoff

import (
	"errors"
	"io"
	"os"
	"sync"
	"time"
)

const flushQueuePerWorker = 2

type flushFile interface {
	Sync() error
	Close() error
}

type flushJob struct {
	file      flushFile
	directory *directoryPin
}

func (j flushJob) close() error {
	err := j.file.Close()
	return errors.Join(err, j.directory.Close())
}

// flushPipeline owns submitted file and directory handles until Sync and Close
// finish. Only the producer touches componentTimer; workers aggregate locally.
// Zero workers is the synchronous reference used by non-Windows helper tests.
type flushPipeline struct {
	jobs    chan flushJob
	workers sync.WaitGroup
	files   sync.WaitGroup
	mu      sync.Mutex
	err     error
	metrics map[string]TimingMetric
	pending int
	peak    int
	timing  *componentTimer
}

func newFlushPipeline(workers int, timing *componentTimer) *flushPipeline {
	p := &flushPipeline{metrics: map[string]TimingMetric{}, timing: timing}
	if timing != nil {
		timing.event.FlushWorkers = workers
	}
	if workers > 0 {
		p.jobs = make(chan flushJob, workers*flushQueuePerWorker)
		for i := 0; i < workers; i++ {
			p.workers.Add(1)
			go func() {
				defer p.workers.Done()
				for job := range p.jobs {
					p.run(job)
				}
			}()
		}
	}
	return p
}

func (p *flushPipeline) failure() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.err
}

// submit always takes ownership, including when an earlier job has failed.
func (p *flushPipeline) submit(job flushJob) error {
	if err := p.failure(); err != nil {
		return errors.Join(err, job.close())
	}
	p.mu.Lock()
	p.pending++
	if p.pending > p.peak {
		p.peak = p.pending
	}
	p.mu.Unlock()
	p.files.Add(1)
	if p.jobs == nil {
		p.run(job)
	} else {
		done := p.timing.start(timingFlushWait)
		p.jobs <- job
		done()
	}
	return p.failure()
}

func (p *flushPipeline) run(job flushJob) {
	defer p.files.Done()
	start := time.Now()
	err := job.file.Sync()
	syncTime := time.Since(start)
	start = time.Now()
	err = errors.Join(err, job.close())
	closeTime := time.Since(start)
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, sample := range []struct {
		phase   string
		elapsed time.Duration
	}{{timingSync, syncTime}, {timingClose, closeTime}} {
		phase, elapsed := sample.phase, sample.elapsed
		metric := p.metrics[phase]
		metric.Calls++
		metric.ElapsedMS += float64(elapsed) / float64(time.Millisecond)
		p.metrics[phase] = metric
	}
	if p.err == nil {
		p.err = err
	}
	p.pending--
}

// Separate small bounded write batches from FlushFileBuffers. On Windows, file
// creation can wait behind concurrent flushes on the same filesystem. All file
// contents are still streamed, and each file still Syncs and Closes. The fixed
// batch bounds retained file handles independently of archive size.
type extractionFlush struct {
	pipeline *flushPipeline
	batch    []flushJob
	limit    int
}

func newExtractionFlush(workers int, timing *componentTimer) *extractionFlush {
	return &extractionFlush{pipeline: newFlushPipeline(workers, timing), limit: workers*(flushQueuePerWorker+1) + 1}
}

func (p *extractionFlush) submit(job flushJob) error {
	p.batch = append(p.batch, job)
	if len(p.batch) == p.limit {
		return p.drain()
	}
	return nil
}

func (p *extractionFlush) drain() error {
	if len(p.batch) == 0 {
		return nil
	}
	done := p.pipeline.timing.start(timingFlushBatch)
	defer done()
	batch := p.batch
	p.batch = nil
	var err error
	for _, job := range batch {
		if err != nil {
			err = errors.Join(err, job.close())
		} else {
			err = p.pipeline.submit(job)
		}
	}
	// No next batch starts creating files until all accepted jobs have closed.
	p.pipeline.files.Wait()
	return errors.Join(err, p.pipeline.failure())
}

func (p *extractionFlush) finish() error {
	err := p.drain()
	return errors.Join(err, p.pipeline.finish())
}

// finish is called exactly once, even on archive/read/hash/path failures. The
// caller must not publish or remove staging until every owned handle is closed.
func (p *flushPipeline) finish() error {
	done := p.timing.start(timingFlushDrain)
	if p.jobs != nil {
		close(p.jobs)
		p.workers.Wait()
	}
	done()
	if p.timing != nil {
		p.timing.event.FlushPeak = p.peak
		for phase, metric := range p.metrics {
			current := p.timing.event.Metrics[phase]
			current.Calls += metric.Calls
			current.ElapsedMS += metric.ElapsedMS
			p.timing.event.Metrics[phase] = current
		}
	}
	return p.err
}

// A completion receipt is written only after the pipeline succeeds. Flush the
// receipt itself before the existing handle-relative component publication.
func writeReceipt(filename string, raw []byte) error {
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	n, err := file.Write(raw)
	if err == nil && n != len(raw) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = file.Sync()
	}
	return errors.Join(err, file.Close())
}
