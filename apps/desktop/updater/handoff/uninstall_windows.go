package handoff

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
	"unsafe"
)

const legacyUpdateCache = "ScholarSeedUpdates"
const cacheEntryLimit = 4096

// Velopack allows 60 seconds for its uninstall hook. Leave room for startup,
// legacy cache cleanup and joining all workers before returning to the SDK.
const runtimeCleanupTimeout = 45 * time.Second
const timingUninstall = "uninstall"

func cleanBeforeUninstall() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return errors.Join(cleanInstalledRuntime(filepath.Dir(self)), cleanLegacyCache())
}

func cleanInstalledRuntime(current string) (err error) {
	if filepath.Base(current) != "current" {
		return errors.New("runtime cleanup requires installed current")
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
	timer := (Policy{}).timer(Component{Kind: RuntimeStoreDirectory, Version: version}, timingUninstall)
	defer timer.finish(&err)
	ctx, cancel := context.WithTimeout(context.Background(), runtimeCleanupTimeout)
	defer cancel()
	files, err := cleanRuntimeTree(ctx, filepath.Join(root, RuntimeStoreDirectory))
	timer.event.Files = int64(files)
	// A cancelled first launch may never have created runtime. Only an absent
	// root is success; a disappearing interior member is still an error.
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND) {
		if _, absent := os.Lstat(filepath.Join(root, RuntimeStoreDirectory)); errors.Is(absent, os.ErrNotExist) {
			return nil
		}
	}
	return err
}

var legacyCacheFile = regexp.MustCompile(`(?i)^(handoff\.exe|Update\.exe|\.velopack_lock|request-[0-9a-f-]{36}\.json|scholarseed-[a-z0-9.-]+\.nupkg|releases\.[a-z0-9.-]+\.json)$`)

// Cleanup never follows reparse points, never touches user data, and preflights
// every leaf with an exclusive DELETE handle before removing anything. Active
// coordinators/downloads or unknown contents preserve the cache for later cleanup.
func cleanLegacyCache() error {
	local, err := localAppData()
	if err != nil {
		return err
	}
	return cleanCache(filepath.Join(local, legacyUpdateCache))
}

func localAppData() (string, error) {
	// Resolve the current token's known folder, not a mutable environment redirect.
	var folder *uint16
	id := syscall.GUID{Data1: 0xf1b32785, Data2: 0x6fba, Data3: 0x4fcf, Data4: [8]byte{0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91}}
	hr, _, _ := shell.NewProc("SHGetKnownFolderPath").Call(uintptr(unsafe.Pointer(&id)), 0, 0, uintptr(unsafe.Pointer(&folder)))
	if hr != 0 {
		return "", fmt.Errorf("LocalAppData lookup failed: %x", hr)
	}
	defer syscall.NewLazyDLL("ole32.dll").NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(folder)))
	chars := unsafe.Slice(folder, 32768)
	for i, ch := range chars {
		if ch == 0 {
			return syscall.UTF16ToString(chars[:i]), nil
		}
	}
	return "", errors.New("invalid LocalAppData path")
}

func cleanCache(directory string) error {
	parents, err := pinLineage(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { closeFiles(parents) }()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) > cacheEntryLimit {
		return errors.New("legacy cache exceeds cleanup budget")
	}
	var handles []syscall.Handle
	defer func() {
		for _, h := range handles {
			syscall.CloseHandle(h)
		}
	}()
	for _, entry := range entries {
		if !legacyCacheFile.MatchString(entry.Name()) || entry.IsDir() {
			return errors.New("legacy cache contains unknown entries; retained")
		}
		name, err := syscall.UTF16PtrFromString(filepath.Join(directory, entry.Name()))
		if err != nil {
			return err
		}
		h, err := syscall.CreateFile(name, 0x10000|0x80, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return fmt.Errorf("legacy cache busy; retained: %w", err)
		}
		handles = append(handles, h)
		var info syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(h, &info); err != nil {
			return err
		}
		if info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
			return errors.New("unsafe legacy cache entry; retained")
		}
	}
	remove := byte(1)
	for _, h := range handles {
		ok, _, err := kernel.NewProc("SetFileInformationByHandle").Call(uintptr(h), 4, uintptr(unsafe.Pointer(&remove)), 1)
		if ok == 0 {
			return err
		}
	}
	for _, h := range handles {
		syscall.CloseHandle(h)
	}
	handles = nil
	closeFiles(parents)
	parents = nil
	// Non-recursive removal cannot follow a swapped directory or remove new data.
	return os.Remove(directory)
}
