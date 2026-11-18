package handoff

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestUpdateCacheSweepReachesEntriesBeyondFirstBatch(t *testing.T) {
	root := t.TempDir()
	packages := filepath.Join(root, "packages")
	if err := os.Mkdir(packages, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i <= cacheSweepEntries; i++ {
		if err := os.Mkdir(filepath.Join(packages, fmt.Sprintf("verified-%06d", i)), 0700); err != nil {
			t.Fatal(err)
		}
	}
	dir, err := os.Open(packages)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil || len(entries) != cacheSweepEntries+1 {
		t.Fatalf("read test entries: %v, %d", err, len(entries))
	}
	expired := filepath.Join(packages, entries[cacheSweepEntries].Name())
	stamp := time.Now().Add(-stagingRetention - time.Hour)
	if err := os.Chtimes(expired, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	sweepUpdateCache(context.Background(), root, "scholarseed", Runtime{}, Runtime{})
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatalf("expired entry after first batch was retained: %v", err)
	}
}

func TestUpdateCacheSweepKeepsCurrentTargetRecentBusyAndUnknown(t *testing.T) {
	root := t.TempDir()
	create := func(relative string, content []byte, before time.Duration) string {
		t.Helper()
		filename := joinPath(root, relative)
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, content, 0600); err != nil {
			t.Fatal(err)
		}
		stamp := time.Now().Add(-before)
		if err := os.Chtimes(filename, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		return filename
	}
	const product = "scholarseed"
	old := archiveRetention + time.Hour
	addArchive := func(version string, age time.Duration) string {
		t.Helper()
		receipt, err := json.Marshal(Receipt{
			Schema: Schema, ProductID: product, Kind: "python", Version: version,
			ArchiveSHA256: strings.Repeat("a", 64),
		})
		if err != nil {
			t.Fatal(err)
		}
		create("runtime/python/"+version+"/"+ReceiptName, receipt, age)
		return create(ArchiveDirectory+"/python-"+version+".zip", []byte("zip"), age)
	}
	expired := addArchive("1-r1", old)
	current := addArchive("2-r1", old)
	target := addArchive("3-r1", old)
	recent := addArchive("4-r1", time.Hour)
	busyArchive := addArchive("5-r1", old)
	unknown := create(ArchiveDirectory+"/python-6-r1.zip", []byte("unknown"), old)
	openArchive, err := os.Open(busyArchive)
	if err != nil {
		t.Fatal(err)
	}
	defer openArchive.Close()
	stage := filepath.Dir(create("packages/verified-ABC123/partial", nil, old))
	busyStage := filepath.Dir(create("packages/verified-DEF456/partial", nil, old))
	partial := filepath.Dir(create("runtime/python/.prepare-123/partial", nil, old))
	stamp := time.Now().Add(-old)
	for _, directory := range []string{stage, busyStage, partial} {
		if err := os.Chtimes(directory, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	// Match Desktop's native directory pin, which requests LIST_DIRECTORY.
	pin, err := pinDirectorySharing(busyStage, 0x80|syscall.FILE_LIST_DIRECTORY, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE)
	if err != nil {
		t.Fatal(err)
	}
	defer pin.Close()

	sweepUpdateCache(context.Background(), root, product,
		Runtime{Components: []Component{{Kind: "python", Version: "2-r1"}}},
		Runtime{Components: []Component{{Kind: "python", Version: "3-r1"}}})
	for _, filename := range []string{expired, stage, partial} {
		if _, err := os.Lstat(filename); !os.IsNotExist(err) {
			t.Errorf("expected obsolete cache entry to be removed: %s (%v)", filename, err)
		}
	}
	for _, filename := range []string{current, target, recent, busyArchive, unknown, busyStage} {
		if _, err := os.Lstat(filename); err != nil {
			t.Errorf("expected cache entry to be retained: %s (%v)", filename, err)
		}
	}
	if _, err := os.Stat(filepath.Join(busyStage, "partial")); err != nil {
		t.Fatalf("active staging content was removed: %v", err)
	}
}
