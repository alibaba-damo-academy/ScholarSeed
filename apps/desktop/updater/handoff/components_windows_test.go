//go:build windows

package handoff

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestExtractionPinBlocksDirectoryMutationButAllowsChildCreation(t *testing.T) {
	root := t.TempDir()
	parents := &extractionDirectories{root: root}
	defer parents.Close()
	pin, err := parents.acquire("nested", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { pin.Close() }()
	name, err := syscall.UTF16PtrFromString(filepath.Join(root, "nested"))
	if err != nil {
		t.Fatal(err)
	}
	openWrite := func() (syscall.Handle, error) {
		return syscall.CreateFile(name, syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	}
	if handle, err := openWrite(); err == nil {
		syscall.CloseHandle(handle)
		t.Fatal("cached directory allowed mutation access")
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "child"), []byte("data"), 0600); err != nil {
		t.Fatal("pin blocked child creation", err)
	}
	if err := parents.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	pin = nil
	// Prove the denial was caused by the pin, not a permanently denied ACL.
	handle, err := openWrite()
	if err != nil {
		t.Fatal("mutation handle unavailable after release", err)
	}
	syscall.CloseHandle(handle)
}

func TestPinnedExternalArchivesCannotChangeBeforeCommit(t *testing.T) {
	p, r, archives := fixture(t)
	root := t.TempDir()
	stageArchives(t, root, r, archives)
	state := &prepared{request: Request{Root: root}, runtime: r}
	defer state.close()
	if _, err := p.preflightComponents(state); err != nil {
		t.Fatal(err)
	}
	filename, _ := componentArchive(root, r.Components[0])
	if file, err := os.OpenFile(filename, os.O_WRONLY|os.O_TRUNC, 0600); err == nil {
		file.Close()
		t.Fatal("pinned archive allowed truncation")
	}
	if err := os.Rename(filename, filename+".replaced"); err == nil {
		t.Fatal("pinned archive allowed replacement")
	}
	directory := filepath.Dir(filename)
	if err := os.Rename(directory, directory+".replaced"); err == nil {
		t.Fatal("pinned archive lineage allowed replacement")
	}
	if err := checkArchive(state.archives[r.Components[0].Kind], r.Components[0]); err != nil {
		t.Fatal(err)
	}
}

func TestExternalArchiveRejectsHardlink(t *testing.T) {
	p, r, archives := fixture(t)
	root := t.TempDir()
	stageArchives(t, root, r, archives)
	filename, _ := componentArchive(root, r.Components[0])
	if err := os.Link(filename, filename+".linked"); err != nil {
		t.Skipf("host cannot create hardlink: %v", err)
	}
	state := &prepared{request: Request{Root: root}, runtime: r}
	defer state.close()
	if _, err := p.preflightComponents(state); err == nil {
		t.Fatal("accepted multiply linked external archive")
	}
}

func TestFlushRetainsDirectoryPinsUntilClose(t *testing.T) {
	root := t.TempDir()
	parents := &extractionDirectories{root: root}
	directory, err := parents.acquire("nested/child", nil)
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}, 1), make(chan struct{})
	file := &gatedFlushFile{started: started, release: release}
	pipeline := newFlushPipeline(2, nil)
	if err := pipeline.submit(flushJob{file: file, directory: directory}); err != nil {
		t.Fatal(err)
	}
	<-started
	// Switching the producer to another branch must retain the pending job's
	// entire lineage, including ancestors shared with the new branch.
	other, err := parents.acquire("nested/other", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	if err := parents.Close(); err != nil {
		t.Fatal(err)
	}
	from, to := filepath.Join(root, "nested"), filepath.Join(root, "replaced")
	renameErr := os.Rename(from, to)
	close(release)
	finishErr := pipeline.finish()
	if renameErr == nil {
		t.Fatal("directory moved while flush owned its handles")
	}
	if finishErr != nil {
		t.Fatal(finishErr)
	}
	if err := os.Rename(from, to); err != nil {
		t.Fatal("directory handles leaked", err)
	}
}
