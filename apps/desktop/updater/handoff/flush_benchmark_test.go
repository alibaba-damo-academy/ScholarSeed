package handoff

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Opt-in real-artifact microbenchmark; this is not installation acceptance.
// Inputs come from an unsigned local build's frozen runtime.json and ZIP folder.
// No production environment switch, signature bypass or delivery fallback exists.
func BenchmarkComponentPreparation(b *testing.B) {
	manifest, archives := os.Getenv("SCHOLARSEED_FLUSH_BENCH_MANIFEST"), os.Getenv("SCHOLARSEED_FLUSH_BENCH_ARCHIVES")
	if manifest == "" || archives == "" {
		b.Skip("set local-build manifest and archive directory for real-artifact comparison")
	}
	raw, err := os.ReadFile(manifest)
	if err != nil {
		b.Fatal(err)
	}
	p := testPolicy()
	p.RuntimeSHA256 = Hash(raw)
	data, err := p.authenticate(raw, true)
	if err != nil {
		b.Fatal(err)
	}
	var identity Runtime
	if err = json.Unmarshal(data, &identity); err != nil {
		b.Fatal(err)
	}
	p.ProductID = identity.ProductID
	p.BundleID = identity.BundleID
	p.AppID = identity.AppID
	p.Target = identity.Target
	r, err := p.ParseRuntime(raw, true)
	if err != nil {
		b.Fatal(err)
	}
	for _, workers := range []int{0, 2, 4} {
		b.Run(fmt.Sprintf("workers_%d", workers), func(b *testing.B) {
			b.StopTimer()
			var totalBytes, totalFiles int64
			for _, c := range r.Components {
				totalBytes += c.ExpandedBytes
				totalFiles += int64(c.FileCount)
			}
			b.SetBytes(totalBytes)
			var peak int
			var syncMS, waitMS, drainMS float64
			p.observeTiming = func(event ComponentTiming) {
				if event.FlushPeak > peak {
					peak = event.FlushPeak
				}
				syncMS += event.Metrics[timingSync].ElapsedMS
				waitMS += event.Metrics[timingFlushWait].ElapsedMS
				drainMS += event.Metrics[timingFlushDrain].ElapsedMS
			}
			for i := 0; i < b.N; i++ {
				root, err := os.MkdirTemp("", "fb-")
				if err != nil {
					b.Fatal(err)
				}
				// Cleanup is excluded from measured preparation and verified on
				// every iteration, including a preparation failure.
				b.StartTimer()
				for _, c := range r.Components {
					_, err = p.prepareComponentWithFlush(root, c, func(c Component) (*os.File, error) { return os.Open(filepath.Join(archives, c.Archive)) }, workers)
					if err != nil {
						break
					}
				}
				b.StopTimer()
				cleanup := os.RemoveAll(root)
				if err != nil || cleanup != nil {
					b.Fatal(err, cleanup)
				}
			}
			b.ReportMetric(float64(totalFiles), "files/op")
			b.ReportMetric(float64(peak), "peak-files")
			b.ReportMetric(syncMS/float64(b.N), "sync-ms/op")
			b.ReportMetric(waitMS/float64(b.N), "queue-ms/op")
			b.ReportMetric(drainMS/float64(b.N), "drain-ms/op")
		})
	}
}
