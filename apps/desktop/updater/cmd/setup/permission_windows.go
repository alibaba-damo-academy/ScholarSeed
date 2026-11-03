package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"scholarseed.local/desktop/updater/handoff"
	"scholarseed.local/desktop/updater/internal/security"
)

var permissionAPI = syscall.NewLazyDLL("advapi32.dll")

const (
	permissionReadControl = 0x00020000
	permissionOwnerDACL   = 0x00000005
	permissionFileObject  = 1
	permissionKnownFlags  = 0x1f
)

func permissionSID(pointer unsafe.Pointer) (string, error) {
	if pointer == nil {
		return "", fmt.Errorf("%w: missing security identifier", errUnsafePermissions)
	}
	valid, _, _ := permissionAPI.NewProc("IsValidSid").Call(uintptr(pointer))
	if valid == 0 {
		return "", fmt.Errorf("%w: invalid security identifier", errUnsafePermissions)
	}
	return (*syscall.SID)(pointer).String()
}

// Matches native/directory.c permissions: no ACL repair or privilege expansion.
func validatePermissions(path string, ancestor bool) error {
	return validatePermissionMode(path, ancestor, false)
}

func validatePermissionMode(path string, ancestor, runtime bool) error {
	return inspectPermissionMode(path, ancestor, runtime, nil)
}

func inspectAncestorPermissions(path string) ([]directoryRisk, error) {
	var risks []directoryRisk
	err := inspectPermissionMode(path, true, false, &risks)
	return risks, err
}

func inspectPermissionMode(path string, ancestor, runtime bool, risks *[]directoryRisk) (err error) {
	defer func() { err = security.Reject("installation", "inspect", "policy_denied", err, path) }()
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(name, permissionReadControl, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("%w: permission check requires a directory without reparse points", errUnsafePermissions)
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	userSID, err := user.User.Sid.String()
	if err != nil {
		return err
	}
	var owner, acl, descriptor unsafe.Pointer
	status, _, _ := permissionAPI.NewProc("GetSecurityInfo").Call(uintptr(handle), permissionFileObject, permissionOwnerDACL, uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	ownerSID, err := permissionSID(owner)
	if err != nil || acl == nil {
		return fmt.Errorf("%w: installation directory has untrusted ownership or unrestricted permissions", errUnsafePermissions)
	}
	role := permissionContent
	if ancestor {
		role = permissionAncestor
		root, rootErr := permissionVolumeRoot(handle)
		if rootErr != nil {
			return rootErr
		}
		if root {
			role = permissionVolume
		}
	}
	if runtime {
		role = permissionRuntime
	}
	ownerAllowed := security.Owner(int(role), security.Authority(ownerSID, userSID))
	if !ownerAllowed && (risks == nil || !ancestor) {
		return security.Reject("installation", "owner", "untrusted_owner", fmt.Errorf("%w: installation directory has untrusted ownership", errUnsafePermissions), path)
	}
	valid, _, _ := permissionAPI.NewProc("IsValidAcl").Call(uintptr(acl))
	if valid == 0 {
		return fmt.Errorf("%w: invalid installation directory ACL", errUnsafePermissions)
	}
	header := unsafe.Slice((*byte)(acl), 8)
	size := int(binary.LittleEndian.Uint16(header[2:4]))
	count := int(binary.LittleEndian.Uint16(header[4:6]))
	if size < 8 {
		return fmt.Errorf("%w: invalid ACL size", errUnsafePermissions)
	}
	data := unsafe.Slice((*byte)(acl), size)
	if !ownerAllowed {
		*risks = append(*risks, directoryRisk{Path: path, Principal: ownerSID, Reason: directoryRiskOwner})
	}
	var entries []permissionEntry
	position := 8
	for i := 0; i < count; i++ {
		if position+16 > len(data) {
			return fmt.Errorf("%w: truncated directory ACE", errUnsafePermissions)
		}
		ace := data[position:]
		length := int(binary.LittleEndian.Uint16(ace[2:4]))
		if (ace[0] != 0 && ace[0] != 1) || ace[1]&^byte(permissionKnownFlags) != 0 || length < 16 || length > len(ace) {
			return fmt.Errorf("directory ACL cannot be evaluated: unsupported ACE type=%d flags=0x%x", ace[0], ace[1])
		}
		if ace[9] > 15 || 16+4*int(ace[9]) != length {
			return fmt.Errorf("%w: invalid ACE security identifier size", errUnsafePermissions)
		}
		sid, err := permissionSID(unsafe.Add(acl, position+8))
		if err != nil {
			return err
		}
		if sid == security.SidOwnerRights {
			sid = ownerSID
		} // OWNER RIGHTS
		entries = append(entries, permissionEntry{SID: sid, Mask: binary.LittleEndian.Uint32(ace[4:8]), Flags: ace[1], Deny: ace[0] == 1})
		position += length
	}
	if runtime {
		subjects, err := permissionTokenSubjects(token, userSID)
		if err != nil {
			return err
		}
		if permissionDeniesExecution(entries, subjects) {
			return security.Reject("installation", "acl", "execution_denied", fmt.Errorf("%w: runtime ACL denies execution to the initiating user", errUnsafePermissions), path)
		}
	}
	for sid, mask := range permissionWriters(entries, role, func(sid string) bool { return security.Authority(sid, userSID) }) {
		if risks == nil || !ancestor {
			return security.Reject("installation", "acl", "foreign_writer", fmt.Errorf("%w: directory permits mutation by %s (mask=0x%08x)", errUnsafePermissions, sid, mask), path)
		}
		*risks = append(*risks, directoryRisk{Path: path, Principal: sid, Mask: mask, Reason: directoryRiskAccess})
	}
	if risks != nil {
		*risks = normalizeDirectoryRisks(*risks)
	}
	return nil
}

// Resolve the opened object, not the user's drive spelling (SUBST can point at
// an ordinary directory). Only an exact volume-GUID root gets root semantics.
func permissionVolumeRoot(handle syscall.Handle) (bool, error) {
	const volumeGUID = 1
	buffer := make([]uint16, 32768)
	size, _, err := kernel.NewProc("GetFinalPathNameByHandleW").Call(uintptr(handle), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), volumeGUID)
	if size == 0 || size >= uintptr(len(buffer)) {
		return false, fmt.Errorf("resolve permission volume root: %w", err)
	}
	path := syscall.UTF16ToString(buffer[:size])
	return strings.HasPrefix(path, `\\?\Volume{`) && strings.HasSuffix(path, `}\`) && strings.Count(path, `\`) == 4, nil
}

func permissionTokenSubjects(token syscall.Token, user string) (map[string]permissionSubject, error) {
	const enabled, denyOnly = 0x4, 0x10
	subjects := map[string]permissionSubject{user: {Allow: true, Deny: true}}
	const groupLimit = 1024 * 1024
	var length uint32
	err := syscall.GetTokenInformation(token, syscall.TokenGroups, nil, 0, &length)
	if !errors.Is(err, syscall.ERROR_INSUFFICIENT_BUFFER) || length == 0 || length > groupLimit {
		return nil, errors.New("invalid token group size")
	}
	buffer := make([]byte, length)
	if err = syscall.GetTokenInformation(token, syscall.TokenGroups, &buffer[0], length, &length); err != nil {
		return nil, err
	}
	type tokenGroups struct {
		Count   uint32
		Entries [1]syscall.SIDAndAttributes
	}
	metadata := (*tokenGroups)(unsafe.Pointer(&buffer[0]))
	offset, size := unsafe.Offsetof(metadata.Entries), unsafe.Sizeof(syscall.SIDAndAttributes{})
	if uintptr(length) < offset || uintptr(metadata.Count) > (uintptr(length)-offset)/size {
		return nil, errors.New("truncated token groups")
	}
	for _, group := range unsafe.Slice(&metadata.Entries[0], int(metadata.Count)) {
		sid, err := group.Sid.String()
		if err != nil {
			return nil, err
		}
		subjects[sid] = permissionSubject{Allow: group.Attributes&enabled != 0 && group.Attributes&denyOnly == 0, Deny: group.Attributes&(enabled|denyOnly) != 0}
	}
	runtime.KeepAlive(buffer)
	return subjects, nil
}

// The caller verifies this is its empty new root or installed product tree.
// Existing runtime stores and their ancestors are validated without ACL changes.
func secureInstallation(path string) error {
	release, preserved, err := runtimeBoundary(path)
	if err != nil {
		return err
	}
	defer release()
	if !preserved {
		return secureTree(path)
	}
	if err = handoff.RetireApplicationTools(path); err != nil {
		return err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.EqualFold(entry.Name(), handoff.RuntimeStoreDirectory) {
			continue
		}
		if err = secureTree(filepath.Join(path, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func runtimeBoundary(path string) (func(), bool, error) {
	release, present, err := handoff.PinRuntimeStore(path)
	if err != nil {
		return nil, false, err
	}
	if present {
		for _, directory := range []string{path, filepath.Join(path, handoff.RuntimeStoreDirectory)} {
			if err = validatePermissionMode(directory, false, true); err != nil {
				release()
				return nil, false, err
			}
		}
	}
	return release, present, nil
}

func secureTree(path string) error {
	// SetSecurityInfo may propagate inheritable ACEs. Reject links throughout the
	// tree before changing any ACL, including hard links to files outside it.
	if err := filepath.WalkDir(path, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		attrs, ok := info.Sys().(*syscall.Win32FileAttributeData)
		if !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("%w: installation contains a reparse point", errUnsafePermissions)
		}
		pointer, err := syscall.UTF16PtrFromString(name)
		if err != nil {
			return err
		}
		handle, err := syscall.CreateFile(pointer, permissionReadControl, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(handle)
		var identity syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(handle, &identity); err != nil {
			return err
		}
		if identity.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || identity.NumberOfLinks > 1 {
			return fmt.Errorf("%w: installation contains a link", errUnsafePermissions)
		}
		return nil
	}); err != nil {
		return err
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return err
	}
	sddl, err := syscall.UTF16PtrFromString("D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	var descriptor unsafe.Pointer
	ok, _, err := permissionAPI.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return err
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	var present, defaulted uint32
	var acl unsafe.Pointer
	ok, _, err = permissionAPI.NewProc("GetSecurityDescriptorDacl").Call(uintptr(descriptor), uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&acl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 {
		return err
	}
	if present == 0 || acl == nil {
		return fmt.Errorf("%w: missing private DACL", errUnsafePermissions)
	}
	return filepath.WalkDir(path, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		pointer, err := syscall.UTF16PtrFromString(name)
		if err != nil {
			return err
		}
		h, err := syscall.CreateFile(pointer, permissionReadControl|0x00040000, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(h)
		var info syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(h, &info); err != nil {
			return err
		}
		if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.NumberOfLinks > 1 {
			return fmt.Errorf("%w: installation contains a link", errUnsafePermissions)
		}
		status, _, _ := permissionAPI.NewProc("SetSecurityInfo").Call(uintptr(h), permissionFileObject, 0x80000004, 0, 0, uintptr(acl), 0)
		if status != 0 {
			return syscall.Errno(status)
		}
		if info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0 {
			return validatePermissions(name, false)
		}
		return nil
	})
}
