//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"

	aclpolicy "scholarseed.local/desktop/updater/internal/security"
)

const (
	toolReadControl           = 0x00020000
	toolWriteDACL             = 0x00040000
	toolReadExecute           = 0x001200a9
	toolFullAccess            = 0x001f01ff
	toolDACLInformation       = 4
	toolOwnerInformation      = 1
	toolProtectedDACL         = 0x80000000
	toolFileObject            = 1
	toolAliasType             = 4
	toolInheritChildren       = 3
	toolInheritOnly           = 8
	toolInheritedACE          = 0x10
	toolACLHeaderBytes        = 8
	toolACEHeaderBytes        = 8
	toolSIDMinimumBytes       = 8
	toolDescriptorRevision    = 1
	toolComputerNameSize      = 256
	toolKnownACEFlags         = 0x1f
	toolDirectoryBufferBytes  = 4096
	toolDirectoryRestartInfo  = 11
	toolDirectoryContinueInfo = 10
	toolDirectoryNameOffset   = 104
	toolNoMoreFiles           = 18
	toolAccountNotMapped      = syscall.Errno(1332)
	toolAliasExists           = 1379
	toolGroupExists           = 2223
	toolGroupInfoLevel        = 1
	toolReadData              = 1
)

func toolPrincipalMissing(err error) bool {
	return errors.Is(err, toolAccountNotMapped)
}

func ensureToolPrincipal() (string, error) {
	principal, err := resolveToolPrincipal()
	if err == nil {
		return principal, nil
	}
	if !toolPrincipalMissing(err) {
		return "", err
	}
	name, err := syscall.UTF16PtrFromString(toolUsersGroup)
	if err != nil {
		return "", err
	}
	comment, err := syscall.UTF16PtrFromString("Codex sandbox internal group (managed)")
	if err != nil {
		return "", err
	}
	information := struct {
		Name    *uint16
		Comment *uint16
	}{Name: name, Comment: comment}
	var parameter uint32
	status, _, _ := syscall.NewLazyDLL("netapi32.dll").NewProc("NetLocalGroupAdd").Call(
		0, toolGroupInfoLevel, uintptr(unsafe.Pointer(&information)), uintptr(unsafe.Pointer(&parameter)),
	)
	if status != 0 && status != toolAliasExists && status != toolGroupExists {
		return "", fmt.Errorf("create sandbox local group failed: status=%d parameter=%d", status, parameter)
	}
	return resolveToolPrincipal()
}

func toolAdmissionFor(parent processWaiter) (*toolAdmission, error) {
	process, valid := parent.(*windowsWaiter)
	if !valid || process == nil || !process.Alive() {
		return nil, errors.New("tool admission requires the live pinned coordinator")
	}
	var token syscall.Token
	if err := syscall.OpenProcessToken(process.handle, syscall.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	owner, err := user.User.Sid.String()
	if err != nil {
		return nil, err
	}
	principal, err := resolveToolPrincipal()
	if err != nil {
		return nil, err
	}
	if owner == principal || aclpolicy.MachineAuthority(owner) {
		return nil, errors.New("sandbox principal cannot own tool admission")
	}
	return &toolAdmission{principal: principal, owner: owner}, nil
}

func emptyToolStage(handle uintptr) error {
	var buffer [toolDirectoryBufferBytes]byte
	information := uintptr(toolDirectoryRestartInfo)
	for {
		ok, _, callErr := kernel.NewProc("GetFileInformationByHandleEx").Call(handle, information, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if ok == 0 {
			if callErr == syscall.Errno(toolNoMoreFiles) {
				return nil
			}
			return callErr
		}
		for offset := 0; ; {
			if offset+toolDirectoryNameOffset > len(buffer) {
				return errors.New("invalid tool stage directory metadata")
			}
			entry := buffer[offset:]
			length := int(binary.LittleEndian.Uint32(entry[60:64]))
			if length == 0 || length%2 != 0 || length > len(entry)-toolDirectoryNameOffset {
				return errors.New("invalid tool stage member name")
			}
			name := syscall.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&entry[toolDirectoryNameOffset])), length/2))
			if name != "." && name != ".." {
				return errors.New("inheritable tool permissions require an empty staging directory")
			}
			next := int(binary.LittleEndian.Uint32(entry[:4]))
			if next == 0 {
				break
			}
			if next < toolDirectoryNameOffset+length || next > len(entry) {
				return errors.New("invalid tool stage directory chain")
			}
			offset += next
		}
		information = toolDirectoryContinueInfo
	}
}

func resolveToolPrincipal() (string, error) {
	var name [toolComputerNameSize]uint16
	length := uint32(len(name))
	ok, _, callErr := kernel.NewProc("GetComputerNameW").Call(uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return "", callErr
	}
	computer := syscall.UTF16ToString(name[:length])
	principal, domain, accountType, err := syscall.LookupSID("", computer+`\`+toolUsersGroup)
	if err != nil {
		return "", fmt.Errorf("official Windows sandbox provisioning required: %w", err)
	}
	if accountType != toolAliasType || !strings.EqualFold(domain, computer) {
		return "", errors.New("sandbox principal is not a machine-local alias")
	}
	text, err := principal.String()
	if err != nil || !strings.HasPrefix(text, "S-1-5-21-") || len(strings.Split(text, "-")) != 8 {
		return "", errors.New("invalid machine-local sandbox identifier")
	}
	return text, nil
}

func toolHandle(path string, access uint32) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	handle, err := syscall.CreateFile(name, access|toolReadData, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	var identity syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(handle, &identity); err != nil || identity.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || identity.NumberOfLinks > 1 {
		syscall.CloseHandle(handle)
		return 0, errors.New("tool admission refuses redirected or multiply-linked objects")
	}
	return handle, nil
}

func toolRootIdentity(path string) (string, error) {
	pins, err := pinLineage(path)
	if err != nil {
		return "", err
	}
	defer closeFiles(pins)
	handle, err := toolHandle(path, 0)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(handle)
	return toolDirectoryIdentity(handle)
}

func toolDirectoryIdentity(handle syscall.Handle) (string, error) {
	var identity syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &identity); err != nil {
		return "", err
	}
	if identity.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return "", errors.New("tool root is not a directory")
	}
	return fmt.Sprintf("%08x:%08x%08x", identity.VolumeSerialNumber, identity.FileIndexHigh, identity.FileIndexLow), nil
}

func toolStageIdentity(stage *os.File) (string, error) {
	return toolDirectoryIdentity(syscall.Handle(stage.Fd()))
}

func (admission *toolAdmission) validateOwner(owner unsafe.Pointer) (result string, err error) {
	defer func() { err = aclpolicy.Reject("tool_owner", "owner", "untrusted_owner", err, "") }()
	if owner == nil {
		return "", errors.New("tool staging owner is missing")
	}
	valid, _, _ := security.NewProc("IsValidSid").Call(uintptr(owner))
	if valid == 0 {
		return "", errors.New("tool staging owner is invalid")
	}
	text, err := (*syscall.SID)(owner).String()
	if err != nil {
		return "", err
	}
	if !aclpolicy.ToolOwner(text, admission.owner, admission.principal) {
		return "", errors.New("tool staging owner is not an installation authority")
	}
	return text, nil
}

func toolMask(mask uint32) uint32 { return aclpolicy.Mask(mask) }

func (admission *toolAdmission) validateACL(acl unsafe.Pointer, ownerText string) (err error) {
	defer func() { err = aclpolicy.Reject("tool_writer", "acl", "policy_denied", err, "") }()
	if acl == nil {
		return errors.New("tool admission refuses an unrestricted DACL")
	}
	valid, _, _ := security.NewProc("IsValidAcl").Call(uintptr(acl))
	if valid == 0 {
		return errors.New("invalid tool ACL")
	}
	header := unsafe.Slice((*byte)(acl), toolACLHeaderBytes)
	size := int(binary.LittleEndian.Uint16(header[2:4]))
	count := int(binary.LittleEndian.Uint16(header[4:6]))
	if size < toolACLHeaderBytes {
		return errors.New("invalid tool ACL length")
	}
	bytes := unsafe.Slice((*byte)(acl), size)
	position := toolACLHeaderBytes
	var entries []aclpolicy.Entry
	identities := map[string]uint32{}
	for index := 0; index < count; index++ {
		if position+toolACEHeaderBytes+toolSIDMinimumBytes > size {
			return errors.New("truncated tool ACE")
		}
		ace := bytes[position:]
		length := int(binary.LittleEndian.Uint16(ace[2:4]))
		if (ace[0] != 0 && ace[0] != 1) || ace[1]&^byte(toolKnownACEFlags) != 0 || length < toolACEHeaderBytes+toolSIDMinimumBytes || length > len(ace) || int(ace[9])*4+toolACEHeaderBytes+toolSIDMinimumBytes != length {
			return errors.New("unsupported tool ACE")
		}
		principal := (*syscall.SID)(unsafe.Add(acl, position+toolACEHeaderBytes))
		text, err := principal.String()
		if err != nil {
			return err
		}
		mask := toolMask(binary.LittleEndian.Uint32(ace[4:8]))
		// OWNER RIGHTS is trusted only in the installation context: every
		// production caller validates the actual owner before this ACL check.
		id, exists := identities[text]
		if !exists {
			id = uint32(len(identities))
			identities[text] = id
		}
		universal := text == aclpolicy.SidEveryone
		entries = append(entries, aclpolicy.Entry{Principal: id, Mask: mask, Flags: uint32(ace[1]), Deny: ace[0] == 1,
			Trusted:   aclpolicy.ToolWriter(text, admission.owner, ownerText),
			Universal: universal, AllowSubject: text == admission.principal || universal, DenySubject: text == admission.principal || universal})
		if text == admission.principal && mask&^uint32(toolReadExecute) != 0 {
			return errors.New("sandbox tool permission exceeds read/execute")
		}
		position += length
	}
	verdict := aclpolicy.Evaluate(entries, aclpolicy.RoleRuntime, true)
	if verdict.Reason == 2 {
		return errors.New("tool read/execute DENY requires explicit installation repair")
	}
	if verdict.Reason != 0 {
		return fmt.Errorf("tool tree permits writes by an untrusted principal: ACE=%d mask=0x%x scope=%d", verdict.Index, verdict.Mask, verdict.Scope)
	}
	return nil
}

func (admission *toolAdmission) prepare(stage *os.File) (err error) {
	defer func() { err = aclpolicy.Reject("tool_owner", "grant", "policy_denied", err, "") }()
	if admission == nil || admission.owner == "" || admission.principal == "" {
		return errors.New("tool permission preparation requires a pinned installation authority")
	}
	principal, err := resolveToolPrincipal()
	if err != nil {
		return err
	}
	if principal != admission.principal {
		return errors.New("sandbox principal changed during installation")
	}
	handle := stage.Fd()
	var identity syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(syscall.Handle(handle), &identity); err != nil || identity.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 || identity.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("tool staging identity is not an ordinary directory")
	}
	if err = emptyToolStage(handle); err != nil {
		return err
	}
	var owner, acl, descriptor unsafe.Pointer
	status, _, _ := security.NewProc("GetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation|toolOwnerInformation, uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	originalOwner, err := admission.validateOwner(owner)
	if err != nil {
		return err
	}
	if err = admission.validateACL(acl, originalOwner); err != nil {
		return err
	}
	sid, err := syscall.StringToSid(principal)
	if err != nil {
		return err
	}
	entry := explicitAccess{Permissions: toolReadExecute, Mode: 1, Inheritance: toolInheritChildren, Trustee: trustee{Form: 0, Type: 2, Name: (*uint16)(unsafe.Pointer(sid))}}
	var merged unsafe.Pointer
	status, _, _ = security.NewProc("SetEntriesInAclW").Call(1, uintptr(unsafe.Pointer(&entry)), uintptr(acl), uintptr(unsafe.Pointer(&merged)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(merged))
	if err = admission.validateACL(merged, originalOwner); err != nil {
		return err
	}
	mergedHeader := unsafe.Slice((*byte)(merged), toolACLHeaderBytes)
	mergedBytes := unsafe.Slice((*byte)(merged), int(binary.LittleEndian.Uint16(mergedHeader[2:4])))
	count := int(binary.LittleEndian.Uint16(mergedHeader[4:6]))
	for index, offset := 0, toolACLHeaderBytes; index < count; index++ {
		ace := mergedBytes[offset:]
		ace[1] &^= toolInheritedACE
		offset += int(binary.LittleEndian.Uint16(ace[2:4]))
	}
	status, _, _ = security.NewProc("SetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation|toolProtectedDACL, 0, 0, uintptr(merged), 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	var actualOwner, actualACL, actualDescriptor unsafe.Pointer
	status, _, _ = security.NewProc("GetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation|toolOwnerInformation, uintptr(unsafe.Pointer(&actualOwner)), 0, uintptr(unsafe.Pointer(&actualACL)), 0, uintptr(unsafe.Pointer(&actualDescriptor)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(actualDescriptor))
	installedOwner, err := admission.validateOwner(actualOwner)
	if err != nil {
		return err
	}
	if installedOwner != originalOwner {
		return errors.New("tool staging owner changed during permission preparation")
	}
	if err = admission.validateACL(actualACL, installedOwner); err != nil {
		return err
	}
	expectedSize := binary.LittleEndian.Uint16(unsafe.Slice((*byte)(merged), toolACLHeaderBytes)[2:4])
	actualSize := binary.LittleEndian.Uint16(unsafe.Slice((*byte)(actualACL), toolACLHeaderBytes)[2:4])
	if expectedSize != actualSize || !bytes.Equal(unsafe.Slice((*byte)(merged), int(expectedSize)), unsafe.Slice((*byte)(actualACL), int(actualSize))) {
		return fmt.Errorf("installed tool ACL differs from the authorized read/execute grant: expected_sha256=%s actual_sha256=%s", Hash(unsafe.Slice((*byte)(merged), int(expectedSize))), Hash(unsafe.Slice((*byte)(actualACL), int(actualSize))))
	}
	return nil
}
