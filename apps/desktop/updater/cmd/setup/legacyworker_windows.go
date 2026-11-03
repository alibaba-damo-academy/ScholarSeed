package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// The elevated entry performs exactly one authenticated legacy removal. It has
// no generic command, environment, install or application-launch operation.
type legacyEnvironmentSnapshot struct {
	Exists bool   `json:"exists"`
	Kind   uint32 `json:"kind"`
	Raw    []byte `json:"raw"`
}

func snapshotLegacyEnvironment(e legacyEnvironment) legacyEnvironmentSnapshot {
	return legacyEnvironmentSnapshot{e.exists, e.kind, e.raw}
}
func (snapshot legacyEnvironmentSnapshot) matches(e legacyEnvironment) bool {
	return e.equal(legacyEnvironment{snapshot.Exists, snapshot.Kind, snapshot.Raw})
}

type legacyWorkerRequest struct {
	ParentPID     uint32                    `json:"parentPid"`
	ParentCreated syscall.Filetime          `json:"parentCreated"`
	Root          string                    `json:"root"`
	Destination   string                    `json:"destination"`
	Executable    string                    `json:"executable"`
	Home          legacyEnvironmentSnapshot `json:"home"`
	MachineHome   legacyEnvironmentSnapshot `json:"machineHome"`
	ProcessHome   string                    `json:"processHome"`
}

func legacyProcessIdentity(process syscall.Handle) (string, syscall.Filetime, error) {
	var token syscall.Token
	if err := syscall.OpenProcessToken(process, syscall.TOKEN_QUERY, &token); err != nil {
		return "", syscall.Filetime{}, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", syscall.Filetime{}, err
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return "", syscall.Filetime{}, err
	}
	var created, exit, kernelTime, userTime syscall.Filetime
	err = syscall.GetProcessTimes(process, &created, &exit, &kernelTime, &userTime)
	return sid, created, err
}
func legacyProcessExecutable(process syscall.Handle) (string, error) {
	var buffer [32768]uint16
	length := uint32(len(buffer))
	ok, _, err := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(process), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return "", err
	}
	return syscall.UTF16ToString(buffer[:length]), nil
}
func (l *legacyInstallation) runUninstaller(executable, parameters, destination, private string) error {
	if !l.machine {
		return runLegacyUninstaller(executable, parameters, false)
	}
	process, err := syscall.OpenProcess(legacyProcessQuery, false, uint32(os.Getpid()))
	if err != nil {
		return err
	}
	_, created, identityErr := legacyProcessIdentity(process)
	syscall.CloseHandle(process)
	if identityErr != nil {
		return identityErr
	}
	request := legacyWorkerRequest{ParentPID: uint32(os.Getpid()), ParentCreated: created, Root: l.root, Destination: destination, Executable: executable, Home: snapshotLegacyEnvironment(l.home), MachineHome: snapshotLegacyEnvironment(l.machineHome), ProcessHome: l.processHome}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	requestPath := filepath.Join(private, "request.json")
	file, err := os.OpenFile(requestPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	pinned, err := holdPayload(requestPath)
	if err != nil {
		return err
	}
	defer pinned.Close()
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return runLegacyUninstaller(self, "--legacy-remove "+syscall.EscapeArg(requestPath), true)
}
func runLegacyWorker(c configuration, args []string) int {
	err := legacyWorker(c, args)
	if errors.Is(err, errLegacyIdentity) {
		return legacyIdentityExit
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
func legacyWorker(c configuration, args []string) error {
	if c.Legacy == nil || validateLegacyPolicy(c.Legacy) != nil || len(args) != 1 {
		return errLegacyUnsupported
	}
	requestFile, err := holdPayload(args[0])
	if err != nil {
		return err
	}
	defer requestFile.Close()
	data, err := io.ReadAll(io.LimitReader(requestFile, 4*legacyEnvironmentLimit+1))
	if err != nil {
		return err
	}
	if len(data) > 4*legacyEnvironmentLimit {
		return errLegacyUnsupported
	}
	var request legacyWorkerRequest
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		return err
	}
	if request.ParentPID == 0 || request.ParentPID == uint32(os.Getpid()) {
		return errLegacyUnsupported
	}
	parent, err := syscall.OpenProcess(legacyProcessQuery|syscall.SYNCHRONIZE, false, request.ParentPID)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(parent)
	sid, created, err := legacyProcessIdentity(parent)
	if err != nil {
		return err
	}
	if created != request.ParentCreated {
		return errLegacyIdentity
	}
	selfProcess, err := syscall.OpenProcess(legacyProcessQuery, false, uint32(os.Getpid()))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(selfProcess)
	selfSID, _, err := legacyProcessIdentity(selfProcess)
	if err != nil {
		return err
	}
	if selfSID != sid {
		return errLegacyIdentity
	}
	// Keep the original migration lease alive even if its UI process is killed.
	lease, _, leaseErr := kernel.NewProc("OpenMutexW").Call(syscall.SYNCHRONIZE, 0, uintptr(unsafe.Pointer(utf(`Local\ScholarSeedLegacyMigration-`+sid))))
	if lease == 0 {
		return leaseErr
	}
	defer syscall.CloseHandle(syscall.Handle(lease))

	parentExecutable, err := legacyProcessExecutable(parent)
	if err != nil {
		return err
	}
	selfExecutable, err := os.Executable()
	if err != nil {
		return err
	}
	// Both sides are the exact same outer executable. The original process must
	// remain alive for the entire removal, not merely leave a reusable request.
	if !sameLegacyPath(parentExecutable, selfExecutable) {
		return errLegacyIdentity
	}
	parentFile, err := holdPayload(parentExecutable)
	if err != nil {
		return err
	}
	defer parentFile.Close()
	selfFile, err := holdPayload(selfExecutable)
	if err != nil {
		return err
	}
	defer selfFile.Close()
	a, err := parentFile.Stat()
	if err != nil {
		return err
	}
	b, err := selfFile.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(a, b) {
		return errLegacyIdentity
	}
	status, err := syscall.WaitForSingleObject(parent, 0)
	if err != nil {
		return err
	}
	if status != syscall.WAIT_TIMEOUT {
		return errLegacyIdentity
	}
	private := filepath.Dir(args[0])
	if !sameLegacyPath(filepath.Dir(request.Executable), private) || filepath.Base(request.Executable) != legacyUninstaller {
		return errLegacyUnsupported
	}
	if err = legacySafeTree(private, true); err != nil {
		return err
	}
	registered, err := legacyRegistry(syscall.HKEY_LOCAL_MACHINE, syscall.KEY_WOW64_64KEY, "")
	if err != nil {
		return err
	}
	if registered == nil || !sameLegacyPath(registered.root, request.Root) {
		return errLegacyUnsupported
	}
	alternate, err := legacyRegistry(syscall.HKEY_LOCAL_MACHINE, syscall.KEY_WOW64_32KEY, "")
	if err != nil {
		return err
	}
	if alternate != nil && (!sameLegacyPath(alternate.root, request.Root) || alternate.command != registered.command) {
		return errLegacyChanged
	}
	// A concurrent per-user installation would make the old NSIS scope selector
	// ambiguous. Never let a request override that discovery.
	for _, view := range []uint32{syscall.KEY_WOW64_64KEY, syscall.KEY_WOW64_32KEY} {
		candidate, e := legacyRegistry(syscall.HKEY_CURRENT_USER, view, "")
		if e != nil {
			return e
		}
		if candidate != nil {
			return errLegacyUnsupported
		}
	}
	inventory, err := parseLegacyInventory(legacyInventory, c.Legacy)
	if err != nil {
		return err
	}
	migration := &legacyInstallation{root: request.Root, machine: true, policy: *c.Legacy, inventory: inventory}
	migration.home, err = readLegacyEnvironment(syscall.HKEY_CURRENT_USER, `Environment`)
	if err != nil {
		return err
	}
	migration.machineHome, err = readLegacyEnvironment(syscall.HKEY_LOCAL_MACHINE, legacyMachineEnvironment)
	if err != nil {
		return err
	}
	if !request.Home.matches(migration.home) || !request.MachineHome.matches(migration.machineHome) {
		return errLegacyChanged
	}
	migration.processHome, migration.processHomeExists = os.LookupEnv(legacyHomeName)
	var profile [syscall.MAX_PATH]uint16
	code, _, _ := shell.NewProc("SHGetFolderPathW").Call(0, 0x0028, 0, 0, uintptr(unsafe.Pointer(&profile[0])))
	if code != 0 {
		return errLegacyUnsupported
	}
	migration.homes = []string{filepath.Join(syscall.UTF16ToString(profile[:]), ".scholarseed")}
	for _, environment := range []legacyEnvironment{migration.home, migration.machineHome} {
		value, e := environment.value()
		if e != nil {
			return e
		}
		if value != "" {
			migration.homes = append(migration.homes, value)
		}
	}
	if migration.processHome != "" {
		migration.homes = append(migration.homes, migration.processHome)
	}
	if request.ProcessHome != "" {
		migration.homes = append(migration.homes, request.ProcessHome)
	}
	if err = migration.preflight(request.Destination); err != nil {
		return err
	}
	if err = migration.verifySource(); err != nil {
		return err
	}
	executable, err := holdPayload(request.Executable)
	if err != nil {
		return err
	}
	defer executable.Close()
	if err = verifyLegacyDigest(executable, c.Legacy.UninstallerSHA256); err != nil {
		return err
	}
	parameters, err := legacyArguments(request.Root, true)
	if err != nil {
		return err
	}
	entry, err := migration.lockStart()
	if err != nil {
		return err
	}
	defer entry.Close()
	if err = migration.checkProcesses(); err != nil {
		return err
	}
	runErr := runLegacyUninstaller(request.Executable, parameters, false)
	return errors.Join(runErr, migration.unchanged())
}
