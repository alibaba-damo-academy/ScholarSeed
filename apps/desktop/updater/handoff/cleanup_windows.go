package handoff

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// Includes the caller: at most three additional workers across the entire tree.
const cleanupWorkers = 4
const cleanupBatch = 256
const cleanupDepth = 64
const cleanupWriteAttributes = 0x100

// Runtime cleanup holds every ancestor against rename and deletes through the
// inspected handle. It never opens file contents, follows links, changes ACLs,
// or leaves workers running after returning. The caller owns the installation.
func cleanRuntimeTree(ctx context.Context, directory string) (uint64, error) {
	pins, err := pinLineage(filepath.Dir(directory))
	if err != nil {
		return 0, err
	}
	defer closeFiles(pins)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := runtimeCleanup{ctx: ctx, cancel: cancel, slots: make(chan struct{}, cleanupWorkers-1)}
	err = c.remove(directory, 0)
	return c.files.Load(), err
}

type runtimeCleanup struct {
	ctx    context.Context
	cancel context.CancelFunc
	slots  chan struct{}
	files  atomic.Uint64
}

func (c *runtimeCleanup) remove(filename string, depth int) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	if depth > cleanupDepth {
		return errors.New("runtime cleanup exceeds directory depth")
	}
	ptr, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return err
	}
	// Request metadata-only access without opening file contents.
	// No delete sharing: the inspected object cannot be swapped before unlink.
	handle, err := syscall.CreateFile(ptr, applicationDeleteAccess|applicationAttributeAccess,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.NumberOfLinks > 1 {
		return errors.New("runtime cleanup refuses redirected or multiply-linked objects")
	}
	directory := info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0
	if depth == 0 && !directory {
		return errors.New("runtime cleanup root is not a directory")
	}
	if directory {
		// The DELETE handle pins identity while a second, delete-sharing handle
		// enumerates. The listing must close before marking the directory deleted.
		listHandle, e := syscall.CreateFile(ptr, syscall.FILE_LIST_DIRECTORY,
			syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
			nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if e != nil {
			return e
		}
		listing := os.NewFile(uintptr(listHandle), filename)
		e = c.children(listing, filename, depth)
		closeErr := listing.Close()
		if e != nil || closeErr != nil {
			return errors.Join(e, closeErr)
		}
	}
	if err = c.ctx.Err(); err != nil {
		return err
	}
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_READONLY != 0 {
		// ReOpenFile operates on the pinned object, never a newly resolved path.
		attributes, _, callErr := kernel.NewProc("ReOpenFile").Call(uintptr(handle),
			cleanupWriteAttributes, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
			syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT)
		if attributes == uintptr(syscall.InvalidHandle) {
			return callErr
		}
		basic := struct {
			Times      [4]int64
			Attributes uint32
			Padding    uint32
		}{Attributes: info.FileAttributes &^ syscall.FILE_ATTRIBUTE_READONLY}
		if basic.Attributes == 0 {
			basic.Attributes = syscall.FILE_ATTRIBUTE_NORMAL
		}
		ok, _, callErr := kernel.NewProc("SetFileInformationByHandle").Call(attributes, 0,
			uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
		syscall.CloseHandle(syscall.Handle(attributes))
		if ok == 0 {
			return callErr
		}
	}
	remove := byte(1)
	ok, _, callErr := kernel.NewProc("SetFileInformationByHandle").Call(uintptr(handle),
		applicationDisposition, uintptr(unsafe.Pointer(&remove)), 1)
	if ok == 0 {
		return callErr
	}
	if !directory {
		c.files.Add(1)
	}
	return nil
}

func (c *runtimeCleanup) children(listing *os.File, directory string, depth int) error {
	var workers sync.WaitGroup
	var first error
	var once sync.Once
	record := func(err error) {
		if err != nil {
			once.Do(func() { first = err; c.cancel() })
		}
	}
loop:
	for {
		if err := c.ctx.Err(); err != nil {
			record(err)
			break
		}
		entries, err := listing.ReadDir(cleanupBatch)
		for _, entry := range entries {
			if e := c.ctx.Err(); e != nil {
				record(e)
				break loop
			}
			name := filepath.Join(directory, entry.Name())
			select {
			case c.slots <- struct{}{}:
				workers.Add(1)
				go func() {
					defer workers.Done()
					defer func() { <-c.slots }()
					record(c.remove(name, depth+1))
				}()
			default:
				record(c.remove(name, depth+1))
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				record(err)
			}
			break
		}
	}
	workers.Wait()
	return first
}
