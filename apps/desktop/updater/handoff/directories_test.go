package handoff

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func directoryArchive(t testing.TB, count int) (*zip.Reader, []Member) {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	var members []Member
	for i := 0; i < count; i++ {
		name := fmt.Sprintf("python/Lib/site-packages/pkg%03d/data/%05d", i/100, i)
		raw := []byte(name)
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write(raw); err != nil {
			t.Fatal(err)
		}
		members = append(members, Member{Path: name, Size: int64(len(raw)), SHA256: Hash(raw)})
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return reader, members
}

func TestExtractionReusesPinnedDirectoryPrefixes(t *testing.T) {
	for _, workers := range []int{0, 2} {
		t.Run(fmt.Sprint(workers), func(t *testing.T) {
			archive, members := directoryArchive(t, 300)
			root := t.TempDir()
			timing := testPolicy().timer(Component{}, timingPrepare)
			if err := verifyArchiveWithFlush(archive, members, root, true, workers, timing); err != nil {
				t.Fatal(err)
			}
			// Three shared ancestors and two directories per package, not five opens per file.
			if got := timing.event.Metrics["directory_pin"].Calls; got != 9 {
				t.Fatalf("directory pins = %d, want 9 for 300 files", got)
			}
			if got := timing.event.Metrics["file_create"].Calls; got != 300 {
				t.Fatalf("file creates = %d", got)
			}
			if got := timing.event.Metrics[timingSync].Calls; got != 300 {
				t.Fatalf("file syncs = %d", got)
			}
			for _, member := range members {
				data, err := os.ReadFile(joinPath(root, member.Path))
				if err != nil || Hash(data) != member.SHA256 {
					t.Fatalf("member %s: %v", member.Path, err)
				}
			}
			moved := root + "-moved"
			if err := os.Rename(root, moved); err != nil {
				t.Fatal("leaked directory handles", err)
			}
			if err := os.Rename(moved, root); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDirectoryPinsReleaseOldBranchesAndRecheckRevisitedPaths(t *testing.T) {
	root := t.TempDir()
	parents := &extractionDirectories{root: root}
	defer parents.Close()
	first, err := parents.acquire("shared/first/leaf", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := parents.acquire("shared/second", nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.parent.parent != second.parent {
		t.Fatal("shared ancestor was reopened")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := first.file.Stat(); err == nil {
		t.Fatal("unused branch still open")
	}
	if _, err := second.parent.file.Stat(); err != nil {
		t.Fatal("shared ancestor closed early", err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(joinPath(root, "shared/first")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(joinPath(root, "shared/first"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if pin, err := parents.acquire("shared/first/leaf", nil); err == nil {
		pin.Close()
		t.Fatal("reused an unpinned path after it became a regular file")
	}
	// Failed traversal must leave the previous chain usable and releasable.
	pin, err := parents.acquire("shared/second", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := parents.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.file.Stat(); err == nil {
		t.Fatal("producer pin leaked")
	}
}

func TestExtractionDirectoriesRejectSymlinkBeforeCreatingChild(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	parents := &extractionDirectories{root: root}
	defer parents.Close()
	if pin, err := parents.acquire("linked/child", nil); err == nil {
		pin.Close()
		t.Fatal("accepted linked parent")
	}
	if _, err := os.Stat(filepath.Join(outside, "child")); !os.IsNotExist(err) {
		t.Fatal("wrote beyond linked parent")
	}
}

func TestComponentExtractionSkipsMemberHashesButReleaseStillChecks(t *testing.T) {
	archive, members := directoryArchive(t, 3)
	members[2].SHA256 = Hash([]byte("different inventory digest"))
	timing := testPolicy().timer(Component{}, timingPrepare)
	if err := verifyArchiveWithFlush(archive, members, t.TempDir(), true, 2, timing); err != nil {
		t.Fatal("component extraction must use the already-verified archive digest", err)
	}
	if timing.event.Metrics[timingHash].Calls != 0 {
		t.Fatal("member SHA-256 still computed")
	}
	if err := verifyArchive(archive, members, t.TempDir(), false); err == nil {
		t.Fatal("release/delta verification lost member digest checks")
	}
	// CRC validation comes from archive/zip's streamed reader, independently of
	// the optional member SHA-256. A late read error must still drain the queue.
	archive.File[2].CRC32 ^= 1
	if err := verifyArchiveWithFlush(archive, members, t.TempDir(), true, 2, nil); err == nil {
		t.Fatal("ZIP checksum failure ignored")
	}
}

// Synthetic directory-heavy extraction, not product acceptance or Windows timing.
func BenchmarkDirectoryExtraction(b *testing.B) {
	for _, workers := range []int{0, 2, 4} {
		b.Run(fmt.Sprintf("workers_%d", workers), func(b *testing.B) { benchmarkDirectoryExtraction(b, workers) })
	}
}

func benchmarkDirectoryExtraction(b *testing.B, workers int) {
	archive, members := directoryArchive(b, 1000)
	base := b.TempDir()
	var directoriesMS, createMS, pinMS, pins, syncMS float64
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		root := filepath.Join(base, fmt.Sprint(i))
		if err := os.Mkdir(root, 0700); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
		timing := testPolicy().timer(Component{}, timingPrepare)
		err := verifyArchiveWithFlush(archive, members, root, true, workers, timing)
		b.StopTimer()
		directoriesMS += timing.event.Metrics[timingDirectories].ElapsedMS
		createMS += timing.event.Metrics["file_create"].ElapsedMS
		pinMS += timing.event.Metrics["directory_pin"].ElapsedMS
		pins += float64(timing.event.Metrics["directory_pin"].Calls)
		syncMS += timing.event.Metrics[timingSync].ElapsedMS
		if err != nil {
			b.Fatal(err)
		}
		if err := os.RemoveAll(root); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
	}
	b.ReportMetric(directoriesMS/float64(b.N), "directories-ms/op")
	b.ReportMetric(createMS/float64(b.N), "file-create-ms/op")
	b.ReportMetric(pinMS/float64(b.N), "directory-pin-ms/op")
	b.ReportMetric(pins/float64(b.N), "directory-pins/op")
	b.ReportMetric(syncMS/float64(b.N), "sync-ms/op")
}
