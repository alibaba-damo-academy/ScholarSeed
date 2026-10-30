package handoff

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const texCacheRelative = "runtime/cache/texlive"
const texCacheRetired = "texlive.retired"
const texCacheLimit = 4096
const texCacheTimeout = 10 * time.Second
const timingTexCache = "update_tex_cache"

// The new installed launcher's SDK callback runs after replacement, before app
// restart. Normal launches, first installs and component preparation never enter.
func maintainAfterUpdate() error {
	return errors.Join(publishUninstaller(), cleanUpdatedTexCache())
}

func cleanUpdatedTexCache() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return cleanInstalledTexCache(filepath.Dir(self))
}

func cleanInstalledTexCache(current string) (err error) {
	if filepath.Base(current) != "current" {
		return errors.New("TeX cleanup requires installed current")
	}
	pins, err := pinLineage(current)
	if err != nil {
		return err
	}
	defer closeFiles(pins)
	root := filepath.Dir(current)
	version, err := installedVersion(root)
	if err != nil {
		return err
	}
	timer := (Policy{}).timer(Component{Kind: "texlive", Version: version}, timingTexCache)
	defer timer.finish(&err)
	directory := joinPath(root, texCacheRelative)
	parents, err := pinLineage(filepath.Dir(directory))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer closeFiles(parents)
	ctx, cancel := context.WithTimeout(context.Background(), texCacheTimeout)
	defer cancel()
	// A previous interrupted deletion is retried only during another update.
	// Neither name is a toolchain archive or an immutable component directory.
	retired := filepath.Join(filepath.Dir(directory), texCacheRetired)
	count, err := resetTexCache(ctx, retired, "")
	timer.event.Files += int64(count)
	if err != nil {
		return fmt.Errorf("retired TeX cache retained: %w", err)
	}
	count, err = resetTexCache(ctx, directory, retired)
	timer.event.Files += int64(count)
	return err
}

type texCacheMember struct {
	file      *os.File
	directory bool
}

type texCacheReservation struct{ members []texCacheMember }

// Every member remains open with no sharing until the complete tree passes
// inspection. DELETE access also conflicts with native directory pins, which
// never share deletion. Preflight failure therefore removes nothing. This OS
// reservation does not depend on user coordination files in an elevated hook.
func (r *texCacheReservation) open(ctx context.Context, name string, depth int) (*os.File, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if depth > cleanupDepth || len(r.members) >= texCacheLimit {
		return nil, false, errors.New("TeX cache exceeds cleanup budget")
	}
	if !filepath.IsAbs(name) || strings.HasPrefix(name, `\\`) {
		return nil, false, errors.New("absolute local TeX cache required")
	}
	// The legacy layout may already exceed MAX_PATH. Use extended local paths;
	// qualification is still no-follow, and every ancestor is held against rename.
	ptr, err := syscall.UTF16PtrFromString(`\\?\` + name)
	if err != nil {
		return nil, false, err
	}
	access := uint32(applicationDeleteAccess | applicationAttributeAccess | syscall.FILE_LIST_DIRECTORY)
	// FILE_LIST_DIRECTORY equals FILE_READ_DATA. No file contents are read; data
	// access makes the deny-sharing reservation effective for all existing users.
	h, err := syscall.CreateFile(ptr, access, 0, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, false, err
	}
	f := os.NewFile(uintptr(h), name)
	r.members = append(r.members, texCacheMember{file: f})
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(h, &info); err != nil {
		return nil, false, err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_READONLY) != 0 || info.NumberOfLinks > 1 {
		return nil, false, errors.New("unsafe TeX cache member")
	}
	directory := info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0
	r.members[len(r.members)-1].directory = directory
	if depth == 0 && !directory {
		return nil, false, errors.New("TeX cache root is not a directory")
	}
	return f, directory, nil
}

func (r *texCacheReservation) inspect(ctx context.Context, name string, depth int) error {
	f, directory, err := r.open(ctx, name, depth)
	if err != nil {
		return err
	}
	if !directory {
		return nil
	}
	return r.children(ctx, f, name, depth)
}

func (r *texCacheReservation) children(ctx context.Context, f *os.File, name string, depth int) error {
	entries, err := f.ReadDir(texCacheLimit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) > texCacheLimit {
		return errors.New("TeX cache directory exceeds budget")
	}
	for _, entry := range entries {
		if err := r.inspect(ctx, filepath.Join(name, entry.Name()), depth+1); err != nil {
			return err
		}
	}
	return nil
}

func (r *texCacheReservation) close() error {
	var failures []error
	for i := len(r.members) - 1; i >= 0; i-- {
		if r.members[i].file != nil {
			failures = append(failures, r.members[i].file.Close())
			r.members[i].file = nil
		}
	}
	return errors.Join(failures...)
}

// The caller pins the installed cache parent. There is no hash/version/content
// classification: the fixed disposable cache namespace is reclaimed as a unit.
// Retire the tree through its inspected handle before inspecting children. A crash
// or partial IO failure cannot leave identity-less files in the active namespace,
// so the next launch can always create a fresh cache using the normal initializer.
func resetTexCache(ctx context.Context, directory, retired string) (removed int, err error) {
	reservation := texCacheReservation{}
	defer func() { err = errors.Join(err, reservation.close()) }()
	root, _, openErr := reservation.open(ctx, directory, 0)
	if openErr != nil {
		if len(reservation.members) == 0 && (errors.Is(openErr, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(openErr, syscall.ERROR_PATH_NOT_FOUND)) {
			return 0, nil
		}
		return 0, openErr
	}
	if err = ctx.Err(); err != nil {
		return 0, err
	}
	if retired != "" {
		// Windows cannot rename a directory while its children deny delete sharing.
		// Retire with the root reserved, then inspect all children before any unlink.
		if err = publishStage(root, directory, retired); err != nil {
			return 0, fmt.Errorf("retire TeX cache: %w", err)
		}
		directory = retired
	}
	if err = reservation.children(ctx, root, directory, 0); err != nil {
		return 0, err
	}

	// Reverse preorder is postorder. Deletion acts on the same inspected handles;
	// never re-resolve a path after retirement or fall back to recursive RemoveAll.
	for i := len(reservation.members) - 1; i >= 0; i-- {
		if err = ctx.Err(); err != nil {
			return removed, err
		}
		member := &reservation.members[i]
		remove := byte(1)
		ok, _, e := kernel.NewProc("SetFileInformationByHandle").Call(member.file.Fd(), applicationDisposition, uintptr(unsafe.Pointer(&remove)), 1)
		if ok == 0 {
			return removed, e
		}
		e = member.file.Close()
		member.file = nil
		if e != nil {
			return removed, e
		}
		if !member.directory {
			removed++
		}
	}
	return removed, nil
}
