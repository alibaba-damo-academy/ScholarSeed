//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"errors"
	"syscall"
	"unsafe"
)

const sandboxDeleteChild = 0x40

// Only the original owner may maintain native credentials. No credential file
// is opened, and the native sandbox group's deny remains byte-for-byte intact.
func sandboxDeleteChildACL(before sandboxSecurity, user, group string, readers ...string) ([]byte, error) {
	if before.owner != user || user == group || group == "" {
		return nil, errors.New("sandbox credential maintenance requires the original owner")
	}
	if err := validateSandboxACL(before, user, group, sandboxRepairACL, readers...); err != nil {
		return nil, err
	}
	return sandboxAppendDirectoryGrant(before.acl, user, sandboxDeleteChild)
}

// The caller must qualify the complete native policy before adding a grant.
func sandboxAppendDirectoryGrant(acl []byte, principal string, mask uint32) ([]byte, error) {
	count := int(binary.LittleEndian.Uint16(acl[4:6]))
	position, insert := toolACLHeaderBytes, len(acl)
	for index := 0; index < count; index++ {
		ace := acl[position:]
		if ace[1]&toolInheritedACE != 0 && insert == len(acl) {
			insert = position
		}
		position += int(binary.LittleEndian.Uint16(ace[2:4]))
	}
	if position != len(acl) || int(binary.LittleEndian.Uint16(acl[2:4])) != position {
		return nil, errors.New("sandbox credential ACL has unreviewed trailing data")
	}
	sid, err := syscall.StringToSid(principal)
	if err != nil {
		return nil, err
	}
	ace := make([]byte, toolACEHeaderBytes+sid.Len())
	// Effective only on this directory; no propagation to credentials or children.
	binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
	binary.LittleEndian.PutUint32(ace[4:8], mask)
	copy(ace[8:], unsafe.Slice((*byte)(unsafe.Pointer(sid)), sid.Len()))
	if len(acl)+len(ace) > 65535 || count == 65535 {
		return nil, errors.New("sandbox credential ACL exceeds bound")
	}
	result := append(bytes.Clone(acl[:insert]), ace...)
	result = append(result, acl[insert:]...)
	binary.LittleEndian.PutUint16(result[2:4], uint16(len(result)))
	binary.LittleEndian.PutUint16(result[4:6], uint16(count+1))
	return result, nil
}

func sandboxEnsureDeleteChild(target string, before sandboxSecurity, user, group string, readers ...string) error {
	probe, err := sandboxOpen(target, toolReadControl|sandboxDeleteChild)
	if err == nil {
		syscall.CloseHandle(probe)
		return nil
	}
	if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		return err
	}
	acl, err := sandboxDeleteChildACL(before, user, group, readers...)
	if err != nil {
		return err
	}
	handle, err := sandboxOpen(target, sandboxMaximumAllowed)
	if err != nil {
		return err
	}
	defer func() {
		if handle != 0 {
			syscall.CloseHandle(handle)
		}
	}()
	current, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	if current.fingerprint() != before.fingerprint() {
		return errors.New("sandbox credential permissions changed before repair")
	}
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation, 0, 0, uintptr(unsafe.Pointer(&acl[0])), 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	// SetSecurityInfo may mark a legacy ACL SE_DACL_AUTO_INHERITED.
	// No protection/control bit may be cleared or otherwise changed.
	after, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	if after.owner != before.owner || after.identity != before.identity || (after.control != before.control && after.control != before.control|0x0400) || !bytes.Equal(after.acl, acl) {
		return errors.New("sandbox credential maintenance changed unexpected security state")
	}
	syscall.CloseHandle(handle)
	handle = 0
	probe, err = sandboxOpen(target, toolReadControl|sandboxDeleteChild)
	if err != nil {
		return err
	}
	syscall.CloseHandle(probe)
	return nil
}

func sandboxAdminCanResetACL(before sandboxSecurity) bool {
	if len(before.acl) < toolACLHeaderBytes {
		return false
	}
	count := int(binary.LittleEndian.Uint16(before.acl[4:6]))
	position := toolACLHeaderBytes
	for index := 0; index < count; index++ {
		if position+toolACEHeaderBytes+toolSIDMinimumBytes > len(before.acl) {
			return false
		}
		ace := before.acl[position:]
		size := int(binary.LittleEndian.Uint16(ace[2:4]))
		if size < toolACEHeaderBytes+toolSIDMinimumBytes || size > len(ace) || int(ace[9])*4+toolACEHeaderBytes+toolSIDMinimumBytes != size {
			return false
		}
		sid, err := (*syscall.SID)(unsafe.Pointer(&ace[8])).String()
		if err != nil {
			return false
		}
		if sid == sandboxAdminSID && ace[0] == 0 && ace[1]&toolInheritOnly == 0 && toolMask(binary.LittleEndian.Uint32(ace[4:8]))&toolWriteDACL != 0 {
			return true
		}
		position += size
	}
	return false
}

func sandboxEnsureSetupWriter(target, user, group, identity string, readers ...string) error {
	h, err := sandboxOpen(target, sandboxMaximumAllowed)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	before, err := sandboxSnapshot(h)
	if err != nil {
		return err
	}
	if identity == "" || before.identity != identity || before.owner != user {
		return errors.New("sandbox setup maintenance requires unchanged original target")
	}
	if err = validateSandboxACL(before, user, group, sandboxRepairACL, readers...); err != nil {
		return err
	}
	if sandboxAdminCanResetACL(before) {
		return nil
	}
	acl, err := sandboxAppendDirectoryGrant(before.acl, sandboxAdminSID, toolWriteDACL)
	if err != nil {
		return err
	}
	return sandboxMetadataWrite(h, before, acl, true)
}
