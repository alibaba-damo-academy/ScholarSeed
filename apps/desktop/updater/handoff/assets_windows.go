//go:build windows

package handoff

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	aclpolicy "scholarseed.local/desktop/updater/internal/security"
	"strings"
	"syscall"
	"unsafe"
)

const (
	applicationTimingKind      = "application"
	applicationReceiptPrefix   = ".tool-access-"
	applicationReceiptLimit    = 4096
	applicationAttributeAccess = 0x80
	applicationSelfRelative    = 0x8000
	applicationAutoInherited   = 0x400
	applicationAutoRequest     = 0x100
	applicationDeleteAccess    = 0x10000
	applicationDisposition     = 4
)

func RetireApplicationTools(root string) error {
	version, err := installedVersion(root)
	if err != nil {
		return err
	}
	filename, err := checkedPath(root, "runtime/"+applicationReceiptPrefix+version+".json")
	if err != nil {
		return err
	}
	pins, err := pinLineage(filepath.Dir(filename))
	if err != nil {
		return err
	}
	defer closeFiles(pins)
	handle, err := toolHandle(filename, syscall.GENERIC_READ|toolReadControl|applicationDeleteAccess)
	if err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return nil
		}
		return err
	}
	file := os.NewFile(uintptr(handle), filename)
	defer file.Close()
	principal, err := resolveToolPrincipal()
	if err != nil {
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
	owner, err := user.User.Sid.String()
	if err != nil {
		return err
	}
	if owner == principal || aclpolicy.MachineAuthority(owner) {
		return errors.New("application admission retirement requires the initiating user")
	}
	admission := &toolAdmission{principal: principal, owner: owner}
	before, err := admission.applicationSecurity(handle)
	if err != nil {
		return err
	}
	metadata, err := file.Stat()
	if err != nil || !metadata.Mode().IsRegular() || metadata.Size() < 1 || metadata.Size() > applicationReceiptLimit {
		return errors.Join(err, errors.New("invalid application admission retirement record"))
	}
	data, err := io.ReadAll(io.LimitReader(file, applicationReceiptLimit+1))
	if err != nil || len(data) > applicationReceiptLimit {
		return errors.Join(err, errors.New("application admission retirement record exceeds bounds"))
	}
	var receipt applicationReceipt
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&receipt); err != nil {
		return err
	}
	var trailing any
	if err = decoder.Decode(&trailing); err != io.EOF {
		return errors.New("trailing application admission retirement data")
	}
	if receipt.Policy != toolAccessPolicy || receipt.PrincipalSID != principal || receipt.PackVersion != version || len(receipt.Roots) != 3 {
		return errors.New("application admission retirement identity differs")
	}
	for index, kind := range []string{"electron", "launchers", "libraries"} {
		item := receipt.Roots[index]
		if item.Kind != kind || len(item.Identity) != 25 || item.Identity[8] != ':' || strings.ToLower(item.Identity) != item.Identity {
			return errors.New("invalid application admission retirement roots")
		}
		if _, err = hex.DecodeString(item.Identity[:8] + item.Identity[9:]); err != nil {
			return errors.New("invalid application admission retirement root identity")
		}
	}
	after, err := admission.applicationSecurity(handle)
	if err != nil || !reflect.DeepEqual(before, after) {
		return errors.Join(err, errors.New("application admission retirement security changed"))
	}
	currentPrincipal, err := resolveToolPrincipal()
	if err != nil || currentPrincipal != principal {
		return errors.Join(err, errors.New("sandbox principal changed during application admission retirement"))
	}
	remove := byte(1)
	ok, _, callErr := kernel.NewProc("SetFileInformationByHandle").Call(uintptr(handle), applicationDisposition, uintptr(unsafe.Pointer(&remove)), unsafe.Sizeof(remove))
	if ok == 0 {
		return callErr
	}
	return nil
}

type applicationRoot struct {
	Kind     string `json:"kind"`
	Identity string `json:"identity"`
	path     string
}

type applicationReceipt struct {
	Policy       int               `json:"policy"`
	PrincipalSID string            `json:"principalSID"`
	PackVersion  string            `json:"packVersion"`
	Roots        []applicationRoot `json:"roots"`
}

type applicationACE struct {
	kind      byte
	flags     byte
	principal string
}

type applicationSecurity struct {
	owner   string
	control uint16
	acl     []byte
	entries map[applicationACE]uint32
}

type applicationAsset struct {
	path     string
	handle   syscall.Handle
	security applicationSecurity
}

type applicationDescriptor struct {
	revision byte
	reserved byte
	control  uint16
	owner    uintptr
	group    uintptr
	sacl     uintptr
	dacl     uintptr
}

func applicationRoots(root string, manifest Runtime) ([]applicationRoot, error) {
	var electron *Component
	for index := range manifest.Components {
		if manifest.Components[index].Kind == "electron" {
			if electron != nil {
				return nil, errors.New("duplicate Electron component admission")
			}
			electron = &manifest.Components[index]
		}
	}
	if electron == nil {
		return nil, errors.New("application tool admission requires Electron component")
	}
	directory, err := componentDirectory(root, *electron)
	if err != nil {
		return nil, err
	}
	return []applicationRoot{
		{Kind: "electron", path: directory},
		{Kind: "launchers", path: joinPath(root, "current/resources/backend/bin")},
		{Kind: "libraries", path: joinPath(root, "current/resources/backend/pylibs")},
	}, nil
}

func (admission *toolAdmission) applicationSecurity(handle syscall.Handle) (snapshot applicationSecurity, err error) {
	defer func() { err = aclpolicy.Reject("tool_owner", "inspect", "policy_denied", err, "") }()
	var owner, acl, descriptor unsafe.Pointer
	status, _, _ := security.NewProc("GetSecurityInfo").Call(uintptr(handle), toolFileObject, toolDACLInformation|toolOwnerInformation, uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		return applicationSecurity{}, syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(descriptor))
	ownerText, err := admission.validateOwner(owner)
	if err != nil {
		return applicationSecurity{}, err
	}
	if err = admission.validateACL(acl, ownerText); err != nil {
		return applicationSecurity{}, err
	}
	var control uint16
	var revision uint32
	ok, _, callErr := security.NewProc("GetSecurityDescriptorControl").Call(uintptr(descriptor), uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 {
		return applicationSecurity{}, callErr
	}
	header := unsafe.Slice((*byte)(acl), toolACLHeaderBytes)
	data := append([]byte(nil), unsafe.Slice((*byte)(acl), int(binary.LittleEndian.Uint16(header[2:4])))...)
	entries, err := applicationEntries(acl)
	if err != nil {
		return applicationSecurity{}, err
	}
	return applicationSecurity{owner: ownerText, control: control, acl: data, entries: entries}, nil
}

func applicationEntries(acl unsafe.Pointer) (map[applicationACE]uint32, error) {
	header := unsafe.Slice((*byte)(acl), toolACLHeaderBytes)
	data := unsafe.Slice((*byte)(acl), int(binary.LittleEndian.Uint16(header[2:4])))
	count := int(binary.LittleEndian.Uint16(header[4:6]))
	entries := make(map[applicationACE]uint32)
	for index, offset := 0, toolACLHeaderBytes; index < count; index++ {
		ace := data[offset:]
		principal, err := (*syscall.SID)(unsafe.Add(acl, offset+toolACEHeaderBytes)).String()
		if err != nil {
			return nil, err
		}
		key := applicationACE{kind: ace[0], flags: ace[1], principal: principal}
		entries[key] |= binary.LittleEndian.Uint32(ace[4:8])
		offset += int(binary.LittleEndian.Uint16(ace[2:4]))
	}
	return entries, nil
}

func applicationHasAccess(snapshot applicationSecurity, principal string) bool {
	var allowed uint32
	for entry, mask := range snapshot.entries {
		if entry.kind == 0 && entry.flags&toolInheritOnly == 0 && entry.principal == principal {
			allowed |= toolMask(mask)
		}
	}
	return allowed&toolReadExecute == toolReadExecute
}

func (admission *toolAdmission) grantApplicationAsset(asset applicationAsset) (err error) {
	defer func() { err = aclpolicy.Reject("tool_writer", "grant", "policy_denied", err, "") }()
	current, err := admission.applicationSecurity(asset.handle)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(current, asset.security) {
		return errors.New("application tool security changed after preflight")
	}
	if applicationHasAccess(current, admission.principal) {
		return nil
	}
	writable, err := toolHandle(asset.path, toolReadControl|toolWriteDACL|applicationAttributeAccess)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(writable)
	var original, reopened syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(asset.handle, &original); err != nil {
		return err
	}
	if err = syscall.GetFileInformationByHandle(writable, &reopened); err != nil {
		return err
	}
	if original.VolumeSerialNumber != reopened.VolumeSerialNumber || original.FileIndexHigh != reopened.FileIndexHigh || original.FileIndexLow != reopened.FileIndexLow {
		return errors.New("application tool identity changed before grant")
	}
	before, err := admission.applicationSecurity(writable)
	if err != nil || !reflect.DeepEqual(before, current) {
		return errors.Join(err, errors.New("application tool security changed before grant"))
	}
	sid, err := syscall.StringToSid(admission.principal)
	if err != nil {
		return err
	}
	entry := explicitAccess{Permissions: toolReadExecute, Mode: 1, Trustee: trustee{Form: 0, Type: 2, Name: (*uint16)(unsafe.Pointer(sid))}}
	var merged unsafe.Pointer
	status, _, _ := security.NewProc("SetEntriesInAclW").Call(1, uintptr(unsafe.Pointer(&entry)), uintptr(unsafe.Pointer(&before.acl[0])), uintptr(unsafe.Pointer(&merged)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer kernel.NewProc("LocalFree").Call(uintptr(merged))
	if err = admission.validateACL(merged, before.owner); err != nil {
		return err
	}
	expected := make(map[applicationACE]uint32, len(before.entries)+1)
	for key, mask := range before.entries {
		expected[key] = mask
	}
	expected[applicationACE{principal: admission.principal}] |= toolReadExecute
	mergedEntries, err := applicationEntries(merged)
	if err != nil || !reflect.DeepEqual(expected, mergedEntries) {
		return errors.Join(err, errors.New("application grant would modify unrelated permissions"))
	}
	beforeWrite, err := admission.applicationSecurity(writable)
	if err != nil || !reflect.DeepEqual(beforeWrite, before) {
		return errors.Join(err, errors.New("application tool security changed during grant"))
	}
	control := before.control &^ applicationSelfRelative
	if control&applicationAutoInherited != 0 {
		control |= applicationAutoRequest
	}
	descriptor := applicationDescriptor{revision: toolDescriptorRevision, control: control, dacl: uintptr(merged)}
	nt := syscall.NewLazyDLL("ntdll.dll")
	code, _, _ := nt.NewProc("NtSetSecurityObject").Call(uintptr(writable), toolDACLInformation, uintptr(unsafe.Pointer(&descriptor)))
	if int32(code) < 0 {
		win, _, _ := nt.NewProc("RtlNtStatusToDosError").Call(code)
		return syscall.Errno(win)
	}
	after, err := admission.applicationSecurity(writable)
	if err != nil {
		return err
	}
	if after.owner != before.owner || after.control != before.control || !reflect.DeepEqual(after.entries, expected) || !applicationHasAccess(after, admission.principal) {
		return errors.New("application tool grant exceeded its exact RX increment")
	}
	return nil
}

func (p Policy) applicationReceipt(root string, manifest Runtime, packVersion string) (applicationReceipt, string, []*os.File, error) {
	var receipt applicationReceipt
	if p.toolAdmission == nil {
		return receipt, "", nil, errors.New("application tools require installation admission authority")
	}
	if _, err := versionNumbers(packVersion); err != nil {
		return receipt, "", nil, err
	}
	principal, err := resolveToolPrincipal()
	if err != nil || principal != p.toolAdmission.principal {
		return receipt, "", nil, errors.Join(err, errors.New("sandbox principal differs from installation admission"))
	}
	roots, err := applicationRoots(root, manifest)
	if err != nil {
		return receipt, "", nil, err
	}
	var pins []*os.File
	failed := true
	defer func() {
		if failed {
			closeFiles(pins)
		}
	}()
	for index := range roots {
		lineage, pinErr := pinLineage(roots[index].path)
		if pinErr != nil {
			return receipt, "", nil, pinErr
		}
		pins = append(pins, lineage...)
		handle, openErr := toolHandle(roots[index].path, toolReadControl|applicationAttributeAccess)
		if openErr != nil {
			return receipt, "", nil, openErr
		}
		pins = append(pins, os.NewFile(uintptr(handle), roots[index].path))
		if _, err = p.toolAdmission.applicationSecurity(handle); err != nil {
			return receipt, "", nil, err
		}
		roots[index].Identity, err = toolDirectoryIdentity(handle)
		if err != nil {
			return receipt, "", nil, err
		}
	}
	receipt = applicationReceipt{Policy: toolAccessPolicy, PrincipalSID: principal, PackVersion: packVersion, Roots: roots}
	filename := joinPath(root, "runtime/"+applicationReceiptPrefix+packVersion+".json")
	failed = false
	return receipt, filename, pins, nil
}

func (p Policy) readApplicationReceipt(filename string, expected applicationReceipt) (bool, error) {
	handle, err := toolHandle(filename, syscall.GENERIC_READ|toolReadControl)
	if err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return false, nil
		}
		return false, err
	}
	file := os.NewFile(uintptr(handle), filename)
	defer file.Close()
	if _, err = p.toolAdmission.applicationSecurity(handle); err != nil {
		return false, err
	}
	metadata, err := file.Stat()
	if err != nil || !metadata.Mode().IsRegular() || metadata.Size() < 1 || metadata.Size() > applicationReceiptLimit {
		return false, errors.Join(err, errors.New("invalid application tool admission receipt"))
	}
	data, err := io.ReadAll(io.LimitReader(file, applicationReceiptLimit+1))
	if err != nil || len(data) > applicationReceiptLimit {
		return false, errors.Join(err, errors.New("application tool receipt exceeds bounds"))
	}
	var actual applicationReceipt
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&actual); err != nil {
		return false, err
	}
	var trailing any
	if err = decoder.Decode(&trailing); err != io.EOF {
		return false, errors.New("trailing application tool receipt data")
	}
	wanted, err := json.Marshal(expected)
	if err != nil {
		return false, err
	}
	received, err := json.Marshal(actual)
	if err != nil || !bytes.Equal(wanted, received) {
		return false, errors.Join(err, errors.New("application tool admission identity differs; explicit repair required"))
	}
	return true, nil
}

func (p Policy) confirmApplicationRoots(receipt applicationReceipt) error {
	for _, root := range receipt.Roots {
		handle, err := toolHandle(root.path, toolReadControl)
		if err != nil {
			return err
		}
		snapshot, err := p.toolAdmission.applicationSecurity(handle)
		syscall.CloseHandle(handle)
		if err != nil {
			return err
		}
		if !applicationHasAccess(snapshot, receipt.PrincipalSID) {
			return errors.New("application root lost its admitted read/execute permission")
		}
	}
	return nil
}

func (p Policy) applicationToolsReady(root string, manifest Runtime, packVersion string) (bool, error) {
	expected, filename, pins, err := p.applicationReceipt(root, manifest, packVersion)
	if err != nil {
		return false, err
	}
	defer closeFiles(pins)
	ready, err := p.readApplicationReceipt(filename, expected)
	if err != nil || !ready {
		return ready, err
	}
	if err = p.confirmApplicationRoots(expected); err != nil {
		return false, err
	}
	return true, nil
}

func (p Policy) admitApplicationTools(root string, manifest Runtime, packVersion string) (err error) {
	timing := p.timer(Component{Kind: applicationTimingKind, Version: packVersion}, timingPrepare)
	defer timing.finish(&err)
	defer timing.start(timingPermissions)()
	expected, filename, pins, err := p.applicationReceipt(root, manifest, packVersion)
	if err != nil {
		return err
	}
	defer closeFiles(pins)
	ready, err := p.readApplicationReceipt(filename, expected)
	if err != nil {
		return err
	}
	if ready {
		timing.event.Status = "reused"
		return p.confirmApplicationRoots(expected)
	}
	var assets []applicationAsset
	defer func() {
		for _, asset := range assets {
			syscall.CloseHandle(asset.handle)
		}
	}()
	pending := make([]string, 0, len(expected.Roots))
	for _, item := range expected.Roots {
		pending = append(pending, item.path)
	}
	for len(pending) > 0 {
		path := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if len(assets) >= FileLimit {
			return errors.New("application tool asset count exceeds bound")
		}
		handle, openErr := toolHandle(path, toolReadControl|applicationAttributeAccess)
		if openErr != nil {
			return openErr
		}
		assets = append(assets, applicationAsset{path: path, handle: handle})
		timing.event.Files++
		snapshot, snapshotErr := p.toolAdmission.applicationSecurity(handle)
		if snapshotErr != nil {
			return fmt.Errorf("application tool preflight rejected %s: %w", path, snapshotErr)
		}
		assets[len(assets)-1].security = snapshot
		var information syscall.ByHandleFileInformation
		if err = syscall.GetFileInformationByHandle(handle, &information); err != nil {
			return err
		}
		if information.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0 {
			members, readErr := os.ReadDir(path)
			if readErr != nil {
				return readErr
			}
			if len(members) > FileLimit-len(assets)-len(pending) {
				return errors.New("application tool directory exceeds bounds")
			}
			for _, member := range members {
				pending = append(pending, filepath.Join(path, member.Name()))
			}
		}
	}
	for _, asset := range assets {
		if err = p.toolAdmission.grantApplicationAsset(asset); err != nil {
			return fmt.Errorf("application tool grant rejected %s: %w", asset.path, err)
		}
	}
	principal, err := resolveToolPrincipal()
	if err != nil || principal != expected.PrincipalSID {
		return errors.Join(err, errors.New("sandbox principal changed before application admission completion"))
	}
	data, err := json.Marshal(expected)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), applicationReceiptPrefix+"prepare-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	written, writeErr := file.Write(data)
	if writeErr == nil && written != len(data) {
		writeErr = io.ErrShortWrite
	}
	if writeErr == nil {
		writeErr = file.Sync()
	}
	if err = errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	handle, err := toolHandle(temporary, applicationDeleteAccess|toolReadControl)
	if err != nil {
		return err
	}
	pinned := os.NewFile(uintptr(handle), temporary)
	defer pinned.Close()
	if _, err = p.toolAdmission.applicationSecurity(handle); err != nil {
		return err
	}
	return publishStage(pinned, temporary, filename)
}
