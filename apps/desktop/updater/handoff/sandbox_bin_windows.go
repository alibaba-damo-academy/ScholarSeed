//go:build windows

package handoff

import (
	"encoding/binary"
	"errors"
	"path/filepath"
	"syscall"
	"unsafe"
)

const sandboxBinSnapshotPrefix = "bin:"

// Native refresh replaces the bin DACL on every execution. Administrators must
// own this one directory so their implicit WRITE_DAC survives that replacement.
// The original user must retain explicit native maintenance rights after transfer.
func sandboxValidateBinOwner(before sandboxSecurity, user string) error {
	if before.owner != user && before.owner != sandboxAdminSID {
		return errors.New("sandbox bin owner is not reviewed")
	}
	if _, err := sandboxBinACL(before, user); err != nil {
		return err
	}
	position := toolACLHeaderBytes
	count := int(binary.LittleEndian.Uint16(before.acl[4:6]))
	required := uint32(sandboxDenyMask | toolWriteDACL)
	for index := 0; index < count; index++ {
		ace := before.acl[position:]
		size := int(binary.LittleEndian.Uint16(ace[2:4]))
		sid, err := (*syscall.SID)(unsafe.Pointer(&ace[8])).String()
		if err != nil {
			return err
		}
		if sid == user && ace[0] == 0 && ace[1]&toolInheritOnly == 0 && toolMask(binary.LittleEndian.Uint32(ace[4:8]))&required == required {
			return nil
		}
		position += size
	}
	return errors.New("sandbox bin original-user maintenance would be lost")
}

func sandboxEnsureBinOwner(home, user string, elevate func(string) error) error {
	target := filepath.Join(home, ".sandbox-bin")
	handle, err := sandboxOpen(target, toolReadControl)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	before, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	if err = sandboxValidateBinOwner(before, user); err != nil {
		return err
	}
	if before.owner == sandboxAdminSID {
		return nil
	}
	err = sandboxSetOwner(target, before, sandboxAdminSID)
	if err != nil {
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) && !errors.Is(err, syscall.Errno(1314)) && !errors.Is(err, syscall.Errno(1307)) {
			return err
		}
		if err = elevate(before.fingerprint()); err != nil {
			return err
		}
	}
	after, err := sandboxSnapshot(handle)
	if err != nil {
		return err
	}
	if !sandboxOwnerRestored(before, after, sandboxAdminSID) {
		return errors.New("sandbox bin ownership changed unexpected security state")
	}
	return nil
}

// This worker is reached only after RecoverSandbox's installed-image/runtime,
// original coordinator identity, default Home and fixed-volume checks.
func sandboxBinOwnerWorker(home, user, group, expected string, parent processWaiter, readers ...string) error {
	if parent == nil || !parent.Alive() {
		return errors.New("sandbox coordinator exited")
	}
	// The authenticated worker may run as a different administrator. Private
	// ancestors deliberately grant that account no READ_CONTROL. Backup semantics
	// plus this read privilege inspect their policy without widening their DACL.
	if err := sandboxReadPrivilege(); err != nil {
		return err
	}
	if _, err := sandboxCheckAncestors(filepath.Dir(filepath.Dir(home)), home, user, group, readers...); err != nil {
		return err
	}
	target := filepath.Join(home, ".sandbox-bin")
	h, err := sandboxOpen(target, toolReadControl)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	before, err := sandboxSnapshot(h)
	if err != nil {
		return err
	}
	if expected == "" || before.fingerprint() != expected || before.owner != user {
		return errors.New("sandbox bin ownership snapshot changed")
	}
	if err = sandboxValidateBinOwner(before, user); err != nil {
		return err
	}
	if parent == nil || !parent.Alive() {
		return errors.New("sandbox coordinator exited")
	}
	if err = sandboxRestorePrivilege(); err != nil {
		return err
	}
	if parent == nil || !parent.Alive() {
		return errors.New("sandbox coordinator exited")
	}
	return sandboxSetOwner(target, before, sandboxAdminSID)
}
