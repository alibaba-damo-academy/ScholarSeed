//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	aclpolicy "scholarseed.local/desktop/updater/internal/security"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const sandboxMetadata = ".sandbox"
const sandboxLogLimit = 90
const sandboxMaximumAllowed = 0x02000000

// The upstream rolling logger uses UTC dates. Only its bounded, direct log
// entries are repaired; credentials, setup inputs and descendants are not walked.
func sandboxMetadataLog(name string) bool {
	if !strings.HasPrefix(name, "sandbox.") || !strings.HasSuffix(name, ".log") {
		return false
	}
	date := strings.TrimSuffix(strings.TrimPrefix(name, "sandbox."), ".log")
	parsed, err := time.Parse("2006-01-02", date)
	return err == nil && parsed.Format("2006-01-02") == date
}

func sandboxMetadataACL(before sandboxSecurity, user, group string, directory bool, readers ...string) ([]byte, error) {
	// Validate framing first, then recognize only the native metadata group's
	// existing RWX/DELETE allowance. Never add or expand a sandbox-group ACE.
	normalized := before
	normalized.acl = bytes.Clone(before.acl)
	if len(normalized.acl) < toolACLHeaderBytes {
		return nil, errors.New("sandbox metadata ACL truncated")
	}
	count := int(binary.LittleEndian.Uint16(normalized.acl[4:6]))
	position, insert := toolACLHeaderBytes, len(normalized.acl)
	mask := uint32(sandboxDenyMask)
	if directory {
		mask = toolFullAccess
	}
	sufficient := false
	for index := 0; index < count; index++ {
		if position+toolACEHeaderBytes+toolSIDMinimumBytes > len(normalized.acl) {
			return nil, errors.New("sandbox metadata ACE truncated")
		}
		ace := normalized.acl[position:]
		size := int(binary.LittleEndian.Uint16(ace[2:4]))
		if size < toolACEHeaderBytes+toolSIDMinimumBytes || size > len(ace) || int(ace[9])*4+toolACEHeaderBytes+toolSIDMinimumBytes != size || ace[0] != 0 || ace[1]&^byte(toolKnownACEFlags) != 0 {
			return nil, errors.New("sandbox metadata policy is not reviewed")
		}
		sid, err := (*syscall.SID)(unsafe.Pointer(&ace[8])).String()
		if err != nil {
			return nil, err
		}
		access := toolMask(binary.LittleEndian.Uint32(ace[4:8]))
		if sid == sandboxOwnerSID && access != toolFullAccess {
			return nil, errors.New("sandbox metadata owner-rights policy is not reviewed")
		}
		// Inherit-only ACEs are still policy on future metadata/bin children.
		// Ancestor traversal validation alone intentionally skips those entries.
		recognized := aclpolicy.RecoveryWriter(sid, user, before.owner) || (group != "" && sid == group)
		for _, reader := range readers {
			if sid == reader && access&^uint32(toolReadExecute) == 0 {
				recognized = true
			}
		}
		if !recognized {
			return nil, errors.New("sandbox metadata principal is not reviewed")
		}
		if sid == group && group != "" {
			if access&^uint32(sandboxDenyMask) != 0 {
				return nil, errors.New("sandbox metadata grants native group excess authority")
			}
			binary.LittleEndian.PutUint32(ace[4:8], access&uint32(toolReadExecute))
		}
		required := mask
		if directory && before.owner == sandboxAdminSID {
			required = sandboxDenyMask
		}
		if sid == sandboxAdminSID && ace[1]&toolInheritOnly == 0 && access&required == required {
			sufficient = true
		}
		if ace[1]&toolInheritedACE != 0 && insert == len(normalized.acl) {
			insert = position
		}
		position += size
	}
	if position != len(normalized.acl) || int(binary.LittleEndian.Uint16(normalized.acl[2:4])) != position {
		return nil, errors.New("sandbox metadata ACL has trailing data")
	}
	if err := validateSandboxACL(normalized, user, group, sandboxAncestorACL, readers...); err != nil {
		return nil, err
	}
	if sufficient {
		return bytes.Clone(before.acl), nil
	}
	if before.owner != user {
		return nil, errors.New("sandbox metadata maintenance requires the original owner")
	}
	sid, err := syscall.StringToSid(sandboxAdminSID)
	if err != nil {
		return nil, err
	}
	ace := make([]byte, toolACEHeaderBytes+sid.Len())
	// A non-inheriting grant keeps existing descendants untouched.
	binary.LittleEndian.PutUint16(ace[2:4], uint16(len(ace)))
	binary.LittleEndian.PutUint32(ace[4:8], mask)
	copyBytes := unsafe.Slice((*byte)(unsafe.Pointer(sid)), sid.Len())
	copy(ace[8:], copyBytes)
	if len(before.acl)+len(ace) > 65535 || count == 65535 {
		return nil, errors.New("sandbox metadata ACL exceeds bound")
	}
	result := append(bytes.Clone(before.acl[:insert]), ace...)
	result = append(result, before.acl[insert:]...)
	binary.LittleEndian.PutUint16(result[2:4], uint16(len(result)))
	binary.LittleEndian.PutUint16(result[4:6], uint16(count+1))
	return result, nil
}

// SetSecurityInfo on a MAXIMUM_ALLOWED handle does not propagate ACEs to
// existing children. Each direct log is independently pinned and qualified.
func sandboxMetadataWrite(handle syscall.Handle, before sandboxSecurity, acl []byte, directory bool) error {
	current, err := sandboxObjectSnapshot(handle, directory)
	if err != nil {
		return err
	}
	if current.fingerprint() != before.fingerprint() {
		return errors.New("sandbox metadata changed before repair")
	}
	if bytes.Equal(acl, before.acl) {
		return nil
	}
	status, _, _ := security.NewProc("SetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation, 0, 0, uintptr(unsafe.Pointer(&acl[0])), 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	after, err := sandboxObjectSnapshot(handle, directory)
	if err != nil {
		return err
	}
	if after.owner != before.owner || after.identity != before.identity || (after.control != before.control && after.control != before.control|0x0400) || !bytes.Equal(after.acl, acl) {
		return errors.New("sandbox metadata repair changed unexpected security state")
	}
	return nil
}

func sandboxPrepareMetadata(home, user, group string, readers ...string) error {
	for _, path := range []string{filepath.Dir(filepath.Dir(home)), filepath.Dir(home), home} {
		handle, err := sandboxOpen(path, toolReadControl)
		if err != nil {
			return err
		}
		before, err := sandboxSnapshot(handle)
		syscall.CloseHandle(handle)
		if err != nil {
			return err
		}
		if err = validateSandboxACL(before, user, group, sandboxAncestorACL, readers...); err != nil {
			return err
		}
	}
	if err := sandboxPrepareBin(home, user, group, readers...); err != nil {
		return err
	}
	target := filepath.Join(home, sandboxMetadata)
	if _, err := createSandboxDirectory(target, user); err != nil {
		return err
	}
	dir, err := sandboxOpen(target, sandboxMaximumAllowed)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(dir), target)
	defer directory.Close()
	type change struct {
		handle    syscall.Handle
		before    sandboxSecurity
		acl       []byte
		directory bool
	}
	var changes []change
	defer func() {
		for _, change := range changes {
			if !change.directory {
				syscall.CloseHandle(change.handle)
			}
		}
	}()
	before, err := sandboxSnapshot(dir)
	if err != nil {
		return err
	}
	acl, err := sandboxMetadataACL(before, user, group, true, readers...)
	if err != nil {
		return err
	}
	changes = append(changes, change{dir, before, acl, true})
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return err
	}
	logCount := 0
	for _, entry := range entries {
		if !sandboxMetadataLog(entry.Name()) {
			continue
		}
		logCount++
		if logCount > sandboxLogLimit {
			return errors.New("sandbox metadata log count exceeds bound")
		}
		name, err := syscall.UTF16PtrFromString(filepath.Join(target, entry.Name()))
		if err != nil {
			return err
		}
		handle, err := syscall.CreateFile(name, sandboxMaximumAllowed, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return err
		}
		before, err := sandboxObjectSnapshot(handle, false)
		if err != nil {
			syscall.CloseHandle(handle)
			return err
		}
		acl, err := sandboxMetadataACL(before, user, group, false, readers...)
		if err != nil {
			syscall.CloseHandle(handle)
			return err
		}

		changes = append(changes, change{handle, before, acl, false})
	}
	for _, change := range changes {
		if err := sandboxMetadataWrite(change.handle, change.before, change.acl, change.directory); err != nil {
			return err
		}
	}
	return nil
}

// Native elevated setup cannot create this sibling beneath the original user's
// private Home. Prepare only the directory; native code owns helper contents and
// its protected RX sandbox policy. Never traverse or change binary descendants.
func sandboxPrepareBin(home, user, group string, readers ...string) error {
	target := filepath.Join(home, ".sandbox-bin")
	if _, err := createSandboxDirectory(target, user); err != nil {
		return err
	}
	handle, err := sandboxOpen(target, sandboxMaximumAllowed)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	before, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	// Unlike writable metadata, the native bin group is only a reader.
	allowed := append([]string{}, readers...)
	if group != "" {
		allowed = append(allowed, group)
	}
	acl, err := sandboxMetadataACL(before, user, "", true, allowed...)
	if err != nil {
		return err
	}
	return sandboxMetadataWrite(handle, before, acl, true)
}
