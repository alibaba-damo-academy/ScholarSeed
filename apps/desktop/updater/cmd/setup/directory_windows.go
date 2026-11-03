package main

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"scholarseed.local/desktop/updater/handoff"
)

var reservedName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])($|\.)`)

const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\`

func registryString(key syscall.Handle, name string) (string, error) {
	var kind, size uint32
	pointer, _ := syscall.UTF16PtrFromString(name)
	if err := syscall.RegQueryValueEx(key, pointer, nil, &kind, nil, &size); err != nil {
		return "", err
	}
	if kind != syscall.REG_SZ || size > 65536 || size%2 != 0 {
		return "", errors.New("invalid installed directory registry value")
	}
	data := make([]uint16, size/2+1)
	if err := syscall.RegQueryValueEx(key, pointer, nil, &kind, (*byte)(unsafe.Pointer(&data[0])), &size); err != nil {
		return "", err
	}
	return syscall.UTF16ToString(data), nil
}
func registeredDirectory(appID string) (string, error) {
	var key syscall.Handle
	name, _ := syscall.UTF16PtrFromString(uninstallKey + appID)
	err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, name, 0, syscall.KEY_READ, &key)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer syscall.RegCloseKey(key)
	root, err := registryString(key, "InstallLocation")
	if err != nil {
		return "", err
	}
	if root == "" {
		return "", errors.New("registered installation has no directory")
	}
	return filepath.Clean(root), nil
}

func installedDirectory(appID string) (string, error) {
	root, err := registeredDirectory(appID)
	if err != nil || root == "" {
		return root, err
	}
	if err = verifyRegisteredDirectory(root, appID); err != nil {
		return "", err
	}
	return filepath.Clean(root), nil
}

// Discovery must not delete registration: cancellation and failed installation
// leave it intact, and the official engine replaces it after a successful install.
func verifyRegisteredDirectory(root, appID string) error {
	err := verifyInstalled(root, appID)
	if !os.IsNotExist(err) {
		return err
	}
	empty, inspectErr := emptyInstallationDirectory(root)
	if inspectErr != nil {
		return inspectErr
	}
	if empty {
		return nil
	}
	return &directoryIssue{Code: directoryUninstall, Path: root}
}

// Only absent or empty directories qualify. A missing current inside a nonempty
// root is not evidence that its remaining contents belong to this installer.
func emptyInstallationDirectory(root string) (bool, error) {
	for path := filepath.Clean(root); ; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		if err == nil {
			attrs, ok := info.Sys().(*syscall.Win32FileAttributeData)
			if !info.IsDir() || !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return false, errors.New("installation folder must not contain links or reparse points")
			}
		} else if !os.IsNotExist(err) {
			return false, err
		}
		if filepath.Dir(path) == path {
			break
		}
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return true, nil
	}
	return len(entries) == 0 && err == nil, err
}

// Recheck after the directory dialog before creating or securing anything.
// An orphaned registration retains its path but needs first-install preparation.
func prepareInstallationDirectory(root, existing string, c configuration, consent directoryConsent) error {
	risks, err := assessDirectory(root, existing, c)
	if err != nil {
		return err
	}
	if !sameDirectoryRisks(risks, consent.Risks) {
		return &directoryIssue{Code: directoryRiskChanged, Path: root}
	}
	empty, err := emptyInstallationDirectory(root)
	if err != nil || !empty {
		return err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return &directoryIssue{Code: directoryNotWritable, Path: root, Cause: err}
	}
	if err := secureInstallation(root); err != nil {
		return &directoryIssue{Code: directoryPermission, Path: root, Cause: err}
	}
	return nil
}

func verifyInstalled(root, appID string) error {
	for _, name := range []string{"", "current", "current/sq.version", "Update.exe", "current/ScholarSeed.exe"} {
		st, err := os.Lstat(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		attrs, ok := st.Sys().(*syscall.Win32FileAttributeData)
		if !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("registered installation contains a reparse point")
		}
		if name == "current/sq.version" && st.Size() > 65536 {
			return errors.New("installation identity exceeds limit")
		}
	}
	data, err := os.ReadFile(filepath.Join(root, "current", "sq.version"))
	if err != nil {
		return err
	}
	var metadata struct {
		ID string `xml:"metadata>id"`
	}
	if err = xml.Unmarshal(data, &metadata); err != nil {
		return err
	}
	if metadata.ID != appID {
		return errors.New("registered directory belongs to another product")
	}
	for _, p := range []string{"Update.exe", filepath.Join("current", "ScholarSeed.exe")} {
		st, err := os.Lstat(filepath.Join(root, p))
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() {
			return errors.New("installed executable is not a regular file")
		}
	}
	return nil
}
func defaultDirectory(appID string) (string, error) {
	// Resolve the Windows shell's actual per-user LocalAppData, not an override
	// intended for a child application or a command shell environment.
	var path [syscall.MAX_PATH]uint16
	code, _, _ := shell.NewProc("SHGetFolderPathW").Call(0, 0x001c, 0, 0, uintptr(unsafe.Pointer(&path[0])))
	if code != 0 {
		return "", fmt.Errorf("LocalAppData unavailable: %#x", code)
	}
	return filepath.Join(syscall.UTF16ToString(path[:]), appID), nil
}
func validateDirectory(root, existing string, c configuration) error {
	_, err := assessDirectory(root, existing, c)
	return err
}

func assessDirectory(root, existing string, c configuration) ([]directoryRisk, error) {
	var risks []directoryRisk
	err := inspectDirectory(root, existing, c, &risks)
	var issue *directoryIssue
	if err != nil && !errors.As(err, &issue) {
		err = &directoryIssue{Code: directoryInspection, Path: root, Cause: err}
	}
	return normalizeDirectoryRisks(risks), err
}

func inspectDirectory(root, existing string, c configuration, risks *[]directoryRisk) error {
	clean := filepath.Clean(root)
	volume := filepath.VolumeName(clean)
	if !filepath.IsAbs(root) || len(volume) != 2 || volume[1] != ':' || clean == volume+`\` || strings.ContainsAny(root, "\x00\r\n") {
		return &directoryIssue{Code: directoryInvalidPath, Path: root}
	}
	if len(utf16.Encode([]rune(clean))) > c.MaxRootUnits {
		return &directoryIssue{Code: directoryTooLong, Path: root, Cause: fmt.Errorf("maximum %d UTF-16 characters", c.MaxRootUnits)}
	}
	for _, part := range strings.Split(strings.TrimPrefix(clean, volume+`\`), `\`) {
		if reservedName.MatchString(part) || strings.IndexFunc(part, func(r rune) bool { return r < 32 }) >= 0 || part == "" || strings.TrimRight(part, " .") != part || strings.ContainsAny(part, `<>:"|?*`) {
			return &directoryIssue{Code: directoryInvalidName, Path: root}
		}
	}
	if existing != "" && !strings.EqualFold(clean, filepath.Clean(existing)) {
		return &directoryIssue{Code: directoryRelocation, Path: root, RegisteredPath: existing}
	}
	// Reject junctions/symlinks anywhere along the selected lineage.
	for p := clean; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err == nil {
			data, ok := info.Sys().(*syscall.Win32FileAttributeData)
			if !info.IsDir() || !ok || data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return &directoryIssue{Code: directoryReparse, Path: p}
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	// Resolve short aliases before protecting system-wide folders.
	canonical, err := canonicalDirectory(clean)
	if err != nil {
		return err
	}
	for _, id := range []uintptr{0x0024, 0x0026, 0x002a, 0x0023} {
		var path [syscall.MAX_PATH]uint16
		code, _, _ := shell.NewProc("SHGetFolderPathW").Call(0, id, 0, 0, uintptr(unsafe.Pointer(&path[0])))
		if code != 0 {
			return errors.New("cannot resolve protected system folders")
		}
		protected, err := canonicalDirectory(syscall.UTF16ToString(path[:]))
		if err != nil {
			return err
		}
		if strings.EqualFold(canonical, protected) || strings.HasPrefix(strings.ToLower(canonical), strings.ToLower(protected)+`\`) {
			return &directoryIssue{Code: directoryProtected, Path: canonical}
		}
	}
	drive, _, _ := kernel.NewProc("GetDriveTypeW").Call(uintptr(unsafe.Pointer(utf(volume + `\`))))
	if drive != 3 {
		return &directoryIssue{Code: directoryDrive, Path: root}
	}
	const persistentACLs = 0x00000008
	var filesystemFlags uint32
	ok, _, volumeErr := kernel.NewProc("GetVolumeInformationW").Call(uintptr(unsafe.Pointer(utf(volume+`\`))), 0, 0, 0, 0, uintptr(unsafe.Pointer(&filesystemFlags)), 0, 0)
	if ok == 0 {
		return &directoryIssue{Code: directoryInspection, Path: volume + `\`, Cause: volumeErr}
	}
	if filesystemFlags&persistentACLs == 0 {
		return &directoryIssue{Code: directoryPermission, Path: volume + `\`, Cause: errors.New("volume does not support persistent Windows ACLs")}
	}
	entries, err := os.ReadDir(clean)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(entries) > 0 {
		if existing == "" {
			return &directoryIssue{Code: directoryNotEmpty, Path: clean}
		}
		if err := verifyInstalled(clean, c.AppID); err != nil {
			return err
		}
		release, preserved, err := runtimeBoundary(clean)
		if err != nil {
			return err
		}
		defer release()
		if err := filepath.WalkDir(clean, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if preserved && strings.EqualFold(path, filepath.Join(clean, handoff.RuntimeStoreDirectory)) {
				return filepath.SkipDir
			}
			if len(utf16.Encode([]rune(path)))+17 > 259 {
				return errors.New("existing installation paths are too long for safe reinstallation")
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			attrs, ok := info.Sys().(*syscall.Win32FileAttributeData)
			if !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return errors.New("existing installation contains a reparse point")
			}
			return nil
		}); err != nil {
			return err
		}
	}
	// Parent directories remain untouched. Verify their ancestry and probe
	// whether an application-owned child can receive its private permissions.
	parent := filepath.Dir(clean)
	for {
		if _, err := os.Stat(parent); err == nil {
			break
		} else if !os.IsNotExist(err) {
			return err
		}
		parent = filepath.Dir(parent)
	}
	for p := parent; ; p = filepath.Dir(p) {
		found, err := inspectAncestorPermissions(p)
		if err != nil {
			return &directoryIssue{Code: directoryInspection, Path: p, Cause: err}
		}
		*risks = append(*risks, found...)
		if filepath.Dir(p) == p {
			break
		}
	}
	probe, err := os.MkdirTemp(parent, ".scholarseed-write-check-")
	if err != nil {
		return &directoryIssue{Code: directoryNotWritable, Path: clean, Cause: err}
	}
	permissionErr := secureInstallation(probe)
	removeErr := os.Remove(probe)
	if permissionErr != nil {
		return &directoryIssue{Code: directoryPermission, Path: clean, Cause: permissionErr}
	}
	if removeErr != nil {
		return removeErr
	}

	return nil
}

func canonicalDirectory(path string) (string, error) {
	parent := path
	var missing []string
	for {
		_, err := os.Stat(parent)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		next := filepath.Dir(parent)
		if next == parent {
			return "", err
		}
		missing = append(missing, filepath.Base(parent))
		parent = next
	}
	var output [32768]uint16
	n, _, err := kernel.NewProc("GetLongPathNameW").Call(uintptr(unsafe.Pointer(utf(parent))), uintptr(unsafe.Pointer(&output[0])), uintptr(len(output)))
	if n == 0 || n >= uintptr(len(output)) {
		return "", err
	}
	result := syscall.UTF16ToString(output[:])
	for i := len(missing) - 1; i >= 0; i-- {
		result = filepath.Join(result, missing[i])
	}
	return result, nil
}

func holdPayload(path string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), path)
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	attrs, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || !info.Mode().IsRegular() || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		file.Close()
		return nil, errors.New("installer payload is not a regular file")
	}
	return file, nil
}
