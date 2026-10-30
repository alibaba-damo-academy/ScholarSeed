//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	aclpolicy "scholarseed.local/desktop/updater/internal/security"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	sandboxWriteOwner       = 0x00080000
	sandboxAttributes       = 0x80
	sandboxOwnerSID         = aclpolicy.SidOwnerRights
	sandboxSystemSID        = aclpolicy.SidSystem
	sandboxUserMask         = 0x001201bf
	sandboxDenyMask         = sandboxUserMask | 0x10000
	sandboxTokenAdjust      = 0x20
	sandboxPrivilegeEnabled = 2
	sandboxPrivilegeMissing = syscall.Errno(1300)
	sandboxDriveFixed       = 3
	sandboxWorkerWait       = time.Duration(0xffffffff) * time.Millisecond
	sandboxLogonGroup       = 0xc0000000
	sandboxEnabledGroup     = 4
	sandboxDenyOnlyGroup    = 0x10
	sandboxTokenGroupLimit  = 1024 * 1024
)

type sandboxSecurity struct {
	owner    string
	acl      []byte
	control  uint16
	identity string
}

type sandboxACLMode int

const (
	sandboxAncestorACL sandboxACLMode = iota
	sandboxPrivateACL
	sandboxRepairACL
)

func (s sandboxSecurity) fingerprint() string {
	return Hash(append([]byte(fmt.Sprintf("%s:%s:%d:", s.owner, s.identity, s.control)), s.acl...))
}

func sandboxToken(parent processWaiter) (syscall.Token, string, string, error) {
	process, valid := parent.(*windowsWaiter)
	if !valid || process == nil || !process.Alive() {
		return 0, "", "", errors.New("sandbox recovery requires a live coordinator")
	}
	var token syscall.Token
	if err := syscall.OpenProcessToken(process.handle, syscall.TOKEN_QUERY, &token); err != nil {
		return 0, "", "", err
	}
	fail := func(err error) (syscall.Token, string, string, error) {
		token.Close()
		return 0, "", "", err
	}
	user, err := token.GetTokenUser()
	if err != nil {
		return fail(err)
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return fail(err)
	}
	if !strings.HasPrefix(sid, "S-1-5-21-") {
		return fail(errors.New("sandbox recovery requires a profile user"))
	}
	// Preserve the live coordinator identity even when its original token is
	// elevated (including the built-in Administrator). Recovery remains bounded
	// by the installed runtime, private path and owner-only checks below.
	var profile [32768]uint16
	length := uint32(len(profile))
	ok, _, callErr := syscall.NewLazyDLL("userenv.dll").NewProc("GetUserProfileDirectoryW").Call(uintptr(token), uintptr(unsafe.Pointer(&profile[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return fail(callErr)
	}
	return token, sid, syscall.UTF16ToString(profile[:]), nil
}

func sandboxSnapshot(handle syscall.Handle) (sandboxSecurity, error) {
	var owner, acl, descriptor unsafe.Pointer
	status, _, _ := security.NewProc("GetSecurityInfo").Call(uintptr(handle), toolFileObject, toolOwnerInformation|toolDACLInformation, uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		return sandboxSecurity{}, syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	if owner == nil || acl == nil {
		return sandboxSecurity{}, errors.New("sandbox security descriptor is incomplete")
	}
	valid, _, _ := security.NewProc("IsValidAcl").Call(uintptr(acl))
	if valid == 0 {
		return sandboxSecurity{}, errors.New("sandbox ACL is invalid")
	}
	ownerSID, err := (*syscall.SID)(owner).String()
	if err != nil {
		return sandboxSecurity{}, err
	}
	header := unsafe.Slice((*byte)(acl), toolACLHeaderBytes)
	size := int(binary.LittleEndian.Uint16(header[2:4]))
	if size < toolACLHeaderBytes {
		return sandboxSecurity{}, errors.New("sandbox ACL is truncated")
	}
	var control uint16
	var revision uint32
	ok, _, callErr := security.NewProc("GetSecurityDescriptorControl").Call(uintptr(descriptor), uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 {
		return sandboxSecurity{}, callErr
	}
	identity, err := toolDirectoryIdentity(handle)
	if err != nil {
		return sandboxSecurity{}, err
	}
	return sandboxSecurity{ownerSID, bytes.Clone(unsafe.Slice((*byte)(acl), size)), control, identity}, nil
}

func validateSandboxACL(snapshot sandboxSecurity, user, group string, mode sandboxACLMode, readers ...string) (err error) {
	defer func() { err = aclpolicy.Reject("recovery_writer", "recovery", "policy_denied", err, "") }()
	if len(snapshot.acl) < toolACLHeaderBytes {
		return errors.New("sandbox ACL header is truncated")
	}
	if !aclpolicy.RecoveryOwner(snapshot.owner, user) {
		return errors.New("sandbox directory owner is not trusted")
	}
	count := int(binary.LittleEndian.Uint16(snapshot.acl[4:6]))
	position := toolACLHeaderBytes
	userAllowed, groupDenied := false, false
	for index := 0; index < count; index++ {
		if position+toolACEHeaderBytes+toolSIDMinimumBytes > len(snapshot.acl) {
			return errors.New("sandbox ACE is truncated")
		}
		ace := snapshot.acl[position:]
		size := int(binary.LittleEndian.Uint16(ace[2:4]))
		if size < toolACEHeaderBytes+toolSIDMinimumBytes || size > len(ace) || (ace[0] != 0 && ace[0] != 1) || ace[1]&^byte(toolKnownACEFlags) != 0 || int(ace[9])*4+toolACEHeaderBytes+toolSIDMinimumBytes != size {
			return errors.New("sandbox ACL contains unsupported ACEs")
		}
		sid, err := (*syscall.SID)(unsafe.Pointer(&ace[8])).String()
		if err != nil {
			return err
		}
		mask := toolMask(binary.LittleEndian.Uint32(ace[4:8]))
		if ace[0] == 1 {
			if sid != group || ace[1]&toolInheritOnly != 0 || mask != sandboxDenyMask {
				return errors.New("sandbox deny policy is not reviewed")
			}
			if mode == sandboxRepairACL && ace[1] != toolInheritChildren {
				return errors.New("sandbox recovery requires the explicit inheritable native deny")
			}
			groupDenied = true
		} else {
			if mode == sandboxAncestorACL && ace[1]&toolInheritOnly != 0 {
				position += size
				continue
			}
			reader := false
			if mode == sandboxAncestorACL && sandboxAncestorTraversal(mask, ace[1]) {
				reader = true
			}
			if group != "" && sid == group && mask&^uint32(toolReadExecute) == 0 {
				if mode == sandboxAncestorACL || (mode == sandboxRepairACL && groupDenied && ace[1]&toolInheritedACE != 0 && mask&^uint32(sandboxDenyMask) == 0) {
					reader = true
				}
			}
			for _, allowed := range readers {
				if sid == allowed && mask&^uint32(toolReadExecute) == 0 {
					reader = true
				}
			}
			if !aclpolicy.RecoveryWriter(sid, user, snapshot.owner) {
				if !reader {
					return errors.New("sandbox directory grants access to an untrusted principal")
				}
			}
			if mask&^uint32(toolFullAccess) != 0 || (sid == sandboxOwnerSID && mask != toolFullAccess) {
				return errors.New("sandbox recovery refuses unknown owner-rights or permissions")
			}
			if sid == user && ace[1]&toolInheritOnly == 0 && mask&sandboxUserMask == sandboxUserMask {
				userAllowed = true
			}
		}
		position += size
	}
	if mode == sandboxRepairACL && (!userAllowed || !groupDenied) {
		return errors.New("sandbox ACL does not match the reviewed private policy")
	}
	return nil
}

func sandboxLogonReaders(token syscall.Token) ([]string, error) {
	var length uint32
	err := syscall.GetTokenInformation(token, syscall.TokenGroups, nil, 0, &length)
	if !errors.Is(err, syscall.ERROR_INSUFFICIENT_BUFFER) || length == 0 || length > sandboxTokenGroupLimit {
		return nil, errors.New("sandbox token group metadata is invalid")
	}
	buffer := make([]byte, length)
	if err = syscall.GetTokenInformation(token, syscall.TokenGroups, &buffer[0], length, &length); err != nil {
		return nil, err
	}
	type entry struct {
		Sid        *syscall.SID
		Attributes uint32
	}
	type groups struct {
		Count   uint32
		Entries [1]entry
	}
	metadata := (*groups)(unsafe.Pointer(&buffer[0]))
	offset, size := unsafe.Offsetof(metadata.Entries), unsafe.Sizeof(entry{})
	if uintptr(length) < offset || uintptr(metadata.Count) > (uintptr(length)-offset)/size {
		return nil, errors.New("sandbox token group list is truncated")
	}
	var readers []string
	for _, group := range unsafe.Slice(&metadata.Entries[0], int(metadata.Count)) {
		if group.Attributes&sandboxLogonGroup != sandboxLogonGroup || group.Attributes&sandboxEnabledGroup == 0 || group.Attributes&sandboxDenyOnlyGroup != 0 {
			continue
		}
		sid, sidErr := group.Sid.String()
		if sidErr != nil {
			return nil, sidErr
		}
		readers = append(readers, sid)
	}
	return readers, nil
}

func sandboxOpen(path string, access uint32) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	handle, err := syscall.CreateFile(name, access|sandboxAttributes, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(handle, &info); err != nil || info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
		syscall.CloseHandle(handle)
		return 0, errors.New("sandbox recovery refuses redirected directories")
	}
	return handle, nil
}

func sandboxSetOwner(path string, before sandboxSecurity, user string) error {
	handle, err := sandboxOpen(path, toolReadControl|sandboxWriteOwner)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	current, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	if current.fingerprint() != before.fingerprint() {
		return errors.New("sandbox permissions changed before recovery")
	}
	sid, err := syscall.StringToSid(user)
	if err != nil {
		return err
	}
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(handle), toolFileObject, toolOwnerInformation, uintptr(unsafe.Pointer(sid)), 0, 0, 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	after, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	if !sandboxOwnerRestored(before, after, user) {
		return sandboxFailure(sandboxStageVerification, errors.New("sandbox owner recovery verification failed"))
	}
	return nil
}

func sandboxOwnerRestored(before, after sandboxSecurity, user string) bool {
	if after.owner != user || after.identity != before.identity || after.control != before.control {
		return false
	}
	if bytes.Equal(before.acl, after.acl) {
		return true
	}
	if before.owner != sandboxAdminSID || len(before.acl) != len(after.acl) || len(before.acl) < toolACLHeaderBytes || int(binary.LittleEndian.Uint16(before.acl[2:4])) != len(before.acl) {
		return false
	}
	ownerSID, err := syscall.StringToSid(sandboxOwnerSID)
	if err != nil {
		return false
	}
	ownerBytes := unsafe.Slice((*byte)(unsafe.Pointer(ownerSID)), ownerSID.Len())
	normalized := bytes.Clone(after.acl)
	position := toolACLHeaderBytes
	count := int(binary.LittleEndian.Uint16(before.acl[4:6]))
	for index := 0; index < count; index++ {
		if position+toolACEHeaderBytes > len(before.acl) {
			return false
		}
		ace := before.acl[position:]
		size := int(binary.LittleEndian.Uint16(ace[2:4]))
		if size < toolACEHeaderBytes+toolSIDMinimumBytes || size > len(ace) {
			return false
		}
		if ace[0] == 0 && binary.LittleEndian.Uint32(ace[4:8]) == toolFullAccess && bytes.Equal(ace[toolACEHeaderBytes:size], ownerBytes) && (ace[1] == toolInheritChildren || ace[1] == toolInheritChildren|toolInheritedACE) && normalized[position+1] == toolInheritOnly|ace[1]&toolInheritedACE {
			normalized[position+1] = ace[1]
		}
		position += size
	}
	return bytes.Equal(before.acl, normalized)
}

func sandboxRestorePrivilege() error {
	var token syscall.Token
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		return err
	}
	if err = syscall.OpenProcessToken(process, syscall.TOKEN_QUERY|sandboxTokenAdjust, &token); err != nil {
		return err
	}
	defer token.Close()
	name, _ := syscall.UTF16PtrFromString("SeRestorePrivilege")
	var privilege struct {
		Count      uint32
		Low        uint32
		High       int32
		Attributes uint32
	}
	privilege.Count = 1
	privilege.Attributes = sandboxPrivilegeEnabled
	ok, _, callErr := security.NewProc("LookupPrivilegeValueW").Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&privilege.Low)))
	if ok == 0 {
		return callErr
	}
	kernel.NewProc("SetLastError").Call(0)
	ok, _, callErr = security.NewProc("AdjustTokenPrivileges").Call(uintptr(token), 0, uintptr(unsafe.Pointer(&privilege)), 0, 0, 0)
	if callErr == sandboxPrivilegeMissing {
		return sandboxPrivilegeMissing
	}
	if ok == 0 {
		return callErr
	}
	return nil
}

func createSandboxDirectory(path, user string) (bool, error) {
	sddl, err := syscall.UTF16PtrFromString("O:" + user + "D:P(A;OICI;FA;;;" + user + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return false, err
	}
	var descriptor unsafe.Pointer
	ok, _, callErr := security.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(sddl)), toolDescriptorRevision, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return false, callErr
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: uintptr(descriptor)}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	ok, _, callErr = kernel.NewProc("CreateDirectoryW").Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&attributes)))
	if ok == 0 {
		if errors.Is(callErr, syscall.ERROR_ALREADY_EXISTS) {
			return false, nil
		}
		return false, callErr
	}
	return true, nil
}

func sandboxPreparation(target string, before sandboxSecurity, user string, created bool) (SandboxResult, error) {
	probe, accessErr := sandboxOpen(target, toolReadControl|toolWriteDACL)
	if accessErr == nil {
		syscall.CloseHandle(probe)
	} else if !errors.Is(accessErr, syscall.ERROR_ACCESS_DENIED) {
		return SandboxResult{}, accessErr
	}
	if created {
		if before.owner != user {
			return SandboxResult{}, errors.New("new sandbox directory did not acquire the original user owner")
		}
		if accessErr != nil {
			return SandboxResult{}, accessErr
		}
		if err := validateSandboxACL(before, user, "", sandboxPrivateACL); err != nil {
			return SandboxResult{}, err
		}
		return SandboxResult{sandboxPrepared}, nil
	}
	return SandboxResult{sandboxPreparationEvent(before.owner, user, accessErr == nil)}, nil
}

func (p Policy) RecoverSandbox(home, version, executable string, parentID uint32, expected string) (result SandboxResult, failure error) {
	stage := sandboxStageVersion
	defer func() {
		if failure != nil {
			reason := "policy_denied"
			if errors.Is(failure, ErrCancelled) {
				reason = "authorization_cancelled"
			}
			failure = aclpolicy.Reject("recovery_owner", "recovery", reason, failure, home)
			failure = sandboxFailure(stage, failure)
		}
	}()
	if err := validateSandboxVersion(version); err != nil {
		return result, err
	}
	worker := parentID != 0
	if !worker {
		parentID = uint32(os.Getpid())
	}
	stage = sandboxStageCoordinator
	parent, err := openProcessWaiter(parentID)
	if err != nil {
		return result, err
	}
	defer parent.Close()
	stage = sandboxStageInstallation
	self, err := os.Executable()
	if err != nil {
		return result, err
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(self))))
	installed := joinPath(root, HelperRelative)
	if !strings.EqualFold(filepath.Clean(self), installed) {
		return result, errors.New("sandbox recovery requires the installed helper")
	}
	selfPins, err := pinLineage(filepath.Dir(self))
	if err != nil {
		return result, err
	}
	defer closeFiles(selfPins)
	selfFile, err := pinFile(self)
	if err != nil {
		return result, err
	}
	defer selfFile.Close()
	if err = validateRoot(p, root); err != nil {
		return result, err
	}
	stage = sandboxStageRuntime
	raw, err := readBounded(joinPath(root, "current/"+RuntimeManifest), ManifestLimit)
	if err != nil {
		return result, err
	}
	manifest, err := p.ParseRuntime(raw, true)
	if err != nil {
		return result, err
	}
	reviewed := false
	for _, component := range manifest.Components {
		if component.Kind != sandboxHomeName || !sandboxRuntimeVersionMatches(version, component.Version) {
			continue
		}
		directory, entryErr := componentDirectory(root, component)
		if entryErr != nil {
			return result, entryErr
		}
		entry := joinPath(directory, component.Entry)
		if !strings.EqualFold(filepath.Clean(executable), entry) {
			return result, errors.New("sandbox executable differs from the installed runtime")
		}
		entryPins, entryErr := pinLineage(filepath.Dir(entry))
		if entryErr != nil {
			return result, entryErr
		}
		defer closeFiles(entryPins)
		entryFile, entryErr := pinFile(entry)
		if entryErr != nil {
			return result, entryErr
		}
		defer entryFile.Close()
		actual, entryErr := fileHash(entryFile)
		if entryErr != nil {
			return result, entryErr
		}
		for _, member := range component.Files {
			if member.Path == component.Entry && actual == member.SHA256 {
				reviewed = true
			}
		}
	}
	if !reviewed {
		return result, errors.New("installed sandbox runtime identity is not reviewed")
	}
	stage = sandboxStageCoordinator
	if worker {
		process := parent.(*windowsWaiter)
		var image [32768]uint16
		length := uint32(len(image))
		ok, _, callErr := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(process.handle), 0, uintptr(unsafe.Pointer(&image[0])), uintptr(unsafe.Pointer(&length)))
		if ok == 0 {
			return result, callErr
		}
		parentImage, imageErr := pinFile(syscall.UTF16ToString(image[:length]))
		if imageErr != nil {
			return result, imageErr
		}
		defer parentImage.Close()
		parentInfo, imageErr := parentImage.Stat()
		if imageErr != nil {
			return result, imageErr
		}
		selfInfo, imageErr := selfFile.Stat()
		if imageErr != nil || !os.SameFile(parentInfo, selfInfo) {
			return result, errors.New("sandbox coordinator image differs")
		}
	}
	stage = sandboxStageIdentity
	token, user, profile, err := sandboxToken(parent)
	if err != nil {
		return result, err
	}
	defer token.Close()
	stage = sandboxStageLocation
	if !strings.EqualFold(filepath.Clean(home), filepath.Join(profile, sandboxProduct, sandboxHomeName)) {
		if worker {
			return result, errors.New("sandbox worker requires the original default home")
		}
		return SandboxResult{sandboxUnsupported}, nil
	}
	volume, _ := syscall.UTF16PtrFromString(filepath.VolumeName(home) + `\`)
	drive, _, _ := kernel.NewProc("GetDriveTypeW").Call(uintptr(unsafe.Pointer(volume)))
	if drive != sandboxDriveFixed {
		return result, errors.New("sandbox recovery requires a local fixed volume")
	}
	parents, err := pinLineage(home)
	if err != nil {
		return result, err
	}
	defer closeFiles(parents)
	stage = sandboxStageTarget
	target := filepath.Join(home, sandboxSecrets)
	created := false
	handle, err := sandboxOpen(target, toolReadControl)
	if !worker && (errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND)) {
		created, err = createSandboxDirectory(target, user)
		if err != nil {
			return result, err
		}
		handle, err = sandboxOpen(target, toolReadControl)
	}
	if err != nil {
		return result, err
	}
	defer syscall.CloseHandle(handle)
	targetPins, err := pinLineage(target)
	if err != nil {
		return result, err
	}
	defer closeFiles(targetPins)
	before, err := sandboxSnapshot(handle)
	if err != nil {
		return result, err
	}
	if worker {
		if expected == "" || before.fingerprint() != expected {
			return result, errors.New("sandbox recovery snapshot changed")
		}
		if before.owner != sandboxAdminSID {
			return result, errors.New("sandbox recovery owner is not Administrators")
		}
		if !parent.Alive() {
			return result, errors.New("sandbox coordinator exited")
		}
	} else {
		preparation, preparationErr := sandboxPreparation(target, before, user, created)
		if preparationErr != nil {
			return result, preparationErr
		}
		if preparation.Event != sandboxRepairRequired {
			return preparation, nil
		}
	}
	readers, err := sandboxLogonReaders(token)
	if err != nil {
		return result, err
	}
	group, groupErr := resolveToolPrincipal()
	if groupErr != nil {
		return result, groupErr
	}
	if user == group {
		return result, errors.New("sandbox account cannot request owner recovery")
	}
	for _, ancestor := range []struct{ path, stage string }{
		{profile, sandboxStageProfile}, {filepath.Dir(home), sandboxStageProduct}, {home, sandboxStageHome},
	} {
		stage = ancestor.stage
		ancestorHandle, openErr := sandboxOpen(ancestor.path, toolReadControl)
		if openErr != nil {
			return result, openErr
		}
		snapshot, readErr := sandboxSnapshot(ancestorHandle)
		syscall.CloseHandle(ancestorHandle)
		if readErr != nil {
			return result, readErr
		}
		if err = validateSandboxACL(snapshot, user, group, sandboxAncestorACL, readers...); err != nil {
			return result, err
		}
	}
	stage = sandboxStageTarget
	if err = validateSandboxACL(before, user, group, sandboxRepairACL, readers...); err != nil {
		return result, err
	}
	if worker {
		if !parent.Alive() {
			return result, errors.New("sandbox coordinator exited")
		}
		stage = sandboxStagePrivilege
		if err = sandboxRestorePrivilege(); err != nil {
			return result, err
		}
		stage = sandboxStageOwner
		if err = sandboxSetOwner(target, before, user); err != nil {
			return result, err
		}
		return SandboxResult{sandboxRepaired}, nil
	}
	stage = sandboxStageOwner
	if err = sandboxSetOwner(target, before, user); err != nil {
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) && !errors.Is(err, syscall.Errno(1314)) {
			return result, err
		}
		stage = sandboxStageElevation
		child, startErr := startWorker(self, []string{sandboxHomeFlag, home, sandboxVersionFlag, version, sandboxRuntimeFlag, executable, sandboxParentFlag, fmt.Sprint(parentID), sandboxSnapshotFlag, before.fingerprint()}, true)
		if startErr != nil {
			return result, startErr
		}
		defer child.Close()
		stage = sandboxStageWorker
		code, waitErr := child.Wait(sandboxWorkerWait)
		if waitErr != nil {
			return result, waitErr
		}
		if code != 0 {
			return result, sandboxWorkerFailure(code)
		}
	}
	stage = sandboxStageVerification
	after, err := sandboxSnapshot(handle)
	if err != nil {
		return result, err
	}
	if !sandboxOwnerRestored(before, after, user) {
		return result, errors.New("sandbox recovery changed unexpected security state")
	}
	probe, err := sandboxOpen(target, toolReadControl|toolWriteDACL)
	if err != nil {
		return result, err
	}
	syscall.CloseHandle(probe)
	return SandboxResult{sandboxRepaired}, nil
}
