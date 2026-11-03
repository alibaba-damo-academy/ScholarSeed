package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const legacyInstallKey = `Software\` + legacyGUID
const legacyMachineEnvironment = `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
const legacyEnvironmentLimit = 65536
const legacyProductLimit = 1024 * 1024
const legacyProcessQuery = 0x1000
const legacyWaitMilliseconds = 0xffffffff // Keep the original coordinator alive until removal actually exits.

type legacyRegistration struct {
	hive    syscall.Handle
	view    uint32
	root    string
	command string
}
type legacyEnvironment struct {
	exists bool
	kind   uint32
	raw    []byte
}
type legacyInstallation struct {
	root              string
	machine           bool
	registrations     []legacyRegistration
	home              legacyEnvironment
	machineHome       legacyEnvironment
	processHome       string
	processHomeExists bool
	homes             []string
	policy            legacyPolicy
	inventory         []legacyFile
	lease             syscall.Handle
}

func readLegacyEnvironment(hive syscall.Handle, path string) (legacyEnvironment, error) {
	var result legacyEnvironment
	var key syscall.Handle
	err := syscall.RegOpenKeyEx(hive, utf(path), 0, syscall.KEY_READ, &key)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer syscall.RegCloseKey(key)
	var size uint32
	err = syscall.RegQueryValueEx(key, utf(legacyHomeName), nil, &result.kind, nil, &size)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return legacyEnvironment{}, nil
	}
	if err != nil {
		return result, err
	}
	if (result.kind != syscall.REG_SZ && result.kind != syscall.REG_EXPAND_SZ) || size < 2 || size > legacyEnvironmentLimit || size%2 != 0 {
		return result, errors.New("invalid SCHOLARSEED_HOME registry value")
	}
	result.raw = make([]byte, size)
	if err = syscall.RegQueryValueEx(key, utf(legacyHomeName), nil, &result.kind, &result.raw[0], &size); err != nil {
		return result, err
	}
	if (result.kind != syscall.REG_SZ && result.kind != syscall.REG_EXPAND_SZ) || int(size) != len(result.raw) || result.raw[len(result.raw)-2] != 0 || result.raw[len(result.raw)-1] != 0 {
		return result, errLegacyChanged
	}
	result.exists = true
	return result, nil
}
func (e legacyEnvironment) equal(other legacyEnvironment) bool {
	return e.exists == other.exists && e.kind == other.kind && bytes.Equal(e.raw, other.raw)
}
func (e legacyEnvironment) rawValue() (string, error) {
	if !e.exists {
		return "", nil
	}
	words := make([]uint16, len(e.raw)/2)
	for i := range words {
		words[i] = binary.LittleEndian.Uint16(e.raw[i*2:])
	}
	for _, w := range words[:len(words)-1] {
		if w == 0 {
			return "", errors.New("embedded NUL in SCHOLARSEED_HOME")
		}
	}
	return string(utf16.Decode(words[:len(words)-1])), nil
}
func (e legacyEnvironment) value() (string, error) {
	value, err := e.rawValue()
	if err != nil {
		return "", err
	}
	if e.kind == syscall.REG_EXPAND_SZ && value != "" {
		var output [32768]uint16
		n, _, err := kernel.NewProc("ExpandEnvironmentStringsW").Call(uintptr(unsafe.Pointer(utf(value))), uintptr(unsafe.Pointer(&output[0])), uintptr(len(output)))
		if n == 0 || n > uintptr(len(output)) {
			return "", fmt.Errorf("cannot expand SCHOLARSEED_HOME: %v", err)
		}
		value = syscall.UTF16ToString(output[:])
	}
	return value, nil
}
func legacyRegistry(hive syscall.Handle, view uint32, current string) (*legacyRegistration, error) {
	var install, uninstall syscall.Handle
	open := func(name string, dest *syscall.Handle) error {
		return syscall.RegOpenKeyEx(hive, utf(name), 0, syscall.KEY_READ|view, dest)
	}
	a := open(legacyInstallKey, &install)
	b := open(uninstallKey+legacyGUID, &uninstall)
	if a == nil {
		defer syscall.RegCloseKey(install)
	}
	if b == nil {
		defer syscall.RegCloseKey(uninstall)
	}
	if errors.Is(a, syscall.ERROR_FILE_NOT_FOUND) && errors.Is(b, syscall.ERROR_FILE_NOT_FOUND) {
		return nil, nil
	}
	// NSIS can leave its shortcut/settings key after removing the uninstall
	// entry. Treat it as retired only when there is no program tree left.
	// Discovery is read-only: cancellation must not delete settings, and a
	// surviving/unknown file must never authorize cleanup or migration.
	if a == nil && errors.Is(b, syscall.ERROR_FILE_NOT_FOUND) {
		root, err := registryString(install, "InstallLocation")
		if err != nil {
			return nil, err
		}
		if err = legacySafeTree(root, false); err != nil {
			return nil, err
		}
		if err = legacyInstallationRoot(root); err != nil {
			return nil, err
		}
		// current has already passed installedDirectory identity validation. A
		// successful same-path Velopack install must not reactivate this stale key.
		if current != "" && sameLegacyPath(root, current) {
			return nil, nil
		}
		empty, err := emptyInstallationDirectory(root)
		if err != nil {
			return nil, err
		}
		if empty {
			return nil, nil
		}
	}
	if a != nil || b != nil {
		return nil, fmt.Errorf("incomplete legacy installation registration: %w", errLegacyUnsupported)
	}
	root, err := registryString(install, "InstallLocation")
	if err != nil {
		return nil, err
	}
	command, err := registryString(uninstall, "UninstallString")
	if err != nil {
		return nil, err
	}
	scope := "/currentuser"
	if hive == syscall.HKEY_LOCAL_MACHINE {
		scope = "/allusers"
	}
	expected := `"` + filepath.Join(root, legacyUninstaller) + `" ` + scope
	if root == "" || !strings.EqualFold(command, expected) {
		return nil, errLegacyUnsupported
	}
	return &legacyRegistration{hive, view, root, command}, nil
}

func discoverLegacy(p *legacyPolicy, existing string) (installation *legacyInstallation, failure error) {
	var registrations []legacyRegistration
	defer func() {
		if failure != nil {
			root := ""
			if len(registrations) != 0 {
				root = registrations[0].root
			}
			failure = &legacyIssue{Path: root, Cause: failure}
		}
	}()
	for _, hive := range []syscall.Handle{syscall.HKEY_CURRENT_USER, syscall.HKEY_LOCAL_MACHINE} {
		for _, view := range []uint32{syscall.KEY_WOW64_64KEY, syscall.KEY_WOW64_32KEY} {
			candidate, err := legacyRegistry(hive, view, existing)
			if err != nil {
				return nil, err
			}
			if candidate != nil {
				registrations = append(registrations, *candidate)
			}
		}
	}
	if len(registrations) == 0 {
		return nil, nil
	}
	if p == nil || validateLegacyPolicy(p) != nil {
		return nil, errLegacyUnsupported
	}
	if existing != "" {
		return nil, errors.New("both NSIS and Velopack installations are registered")
	}
	inventory, err := parseLegacyInventory(legacyInventory, p)
	if err != nil {
		return nil, err
	}
	first := registrations[0]
	for _, r := range registrations {
		if r.hive != first.hive || !strings.EqualFold(filepath.Clean(r.root), filepath.Clean(first.root)) || !strings.EqualFold(r.command, first.command) {
			return nil, errors.New("conflicting legacy installation registrations")
		}
	}
	// The original x64 installer selects the 64-bit view. A 32-bit-only record
	// cannot be retired by that exact binary and must not authorize uninstall.
	if first.view != syscall.KEY_WOW64_64KEY {
		return nil, errLegacyUnsupported
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return nil, err
	}
	defer token.Close()
	var elevated uint32
	var size uint32
	err = syscall.GetTokenInformation(token, 20, (*byte)(unsafe.Pointer(&elevated)), 4, &size)
	if err != nil {
		return nil, err
	}
	if elevated != 0 {
		return nil, errors.New("run Setup normally as the original user; only legacy removal requests elevation")
	}
	principal, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	sid, err := principal.User.Sid.String()
	if err != nil {
		return nil, err
	}
	handle, _, mutexErr := kernel.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(utf(`Local\ScholarSeedLegacyMigration-`+sid))))
	if handle == 0 {
		return nil, mutexErr
	}
	if mutexErr == syscall.ERROR_ALREADY_EXISTS {
		syscall.CloseHandle(syscall.Handle(handle))
		return nil, errors.New("another migration is already running")
	}
	result := &legacyInstallation{root: filepath.Clean(first.root), machine: first.hive == syscall.HKEY_LOCAL_MACHINE, registrations: registrations, policy: *p, inventory: inventory, lease: syscall.Handle(handle)}
	success := false
	defer func() {
		if !success {
			result.close()
		}
	}()
	result.home, err = readLegacyEnvironment(syscall.HKEY_CURRENT_USER, `Environment`)
	if err != nil {
		return nil, err
	}
	result.machineHome, err = readLegacyEnvironment(syscall.HKEY_LOCAL_MACHINE, legacyMachineEnvironment)
	if err != nil {
		return nil, err
	}
	result.processHome, result.processHomeExists = os.LookupEnv(legacyHomeName)
	var profile [syscall.MAX_PATH]uint16
	code, _, _ := shell.NewProc("SHGetFolderPathW").Call(0, 0x0028, 0, 0, uintptr(unsafe.Pointer(&profile[0])))
	if code != 0 {
		return nil, errors.New("cannot resolve original user's profile")
	}
	defaultHome := filepath.Join(syscall.UTF16ToString(profile[:]), ".scholarseed")
	result.homes = []string{defaultHome}
	for _, e := range []legacyEnvironment{result.home, result.machineHome} {
		value, err := e.value()
		if err != nil {
			return nil, err
		}
		if value != "" {
			result.homes = append(result.homes, value)
		}
	}
	if result.processHome != "" {
		result.homes = append(result.homes, result.processHome)
	}
	// Explorer may have a stale environment. Select the original user's persisted
	// effective value for the new application, preserving raw registry bytes.
	effective, err := result.home.value()
	if err != nil {
		return nil, err
	}
	if effective == "" {
		effective, err = result.machineHome.value()
		if err != nil {
			return nil, err
		}
	}
	if result.processHome != "" && effective != "" && !sameLegacyPath(result.processHome, effective) {
		return nil, errors.New("SCHOLARSEED_HOME differs between this process and user settings; reopen Setup from an updated session")
	}
	success = true
	return result, nil
}
func (l *legacyInstallation) path() string { return l.root }
func (l *legacyInstallation) close() {
	if l != nil && l.lease != 0 {
		syscall.CloseHandle(l.lease)
		l.lease = 0
	}
}
func sameLegacyPath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
func legacyOverlap(a, b string) bool {
	a = strings.ToLower(filepath.Clean(a))
	b = strings.ToLower(filepath.Clean(b))
	return a == b || strings.HasPrefix(a, b+`\`) || strings.HasPrefix(b, a+`\`)
}

// Reject links along the full lineage and in the tree NSIS may recursively
// remove. This also rejects unsafe inherited writers before elevated removal.
func legacySafeTree(root string, recursive bool) error {
	volume := filepath.VolumeName(root)
	if !filepath.IsAbs(root) || len(volume) != 2 || root == volume+`\` || strings.ContainsAny(root, "\x00\r\n\"") {
		return errLegacyUnsupported
	}
	for p := root; ; p = filepath.Dir(p) {
		st, err := os.Lstat(p)
		if err != nil {
			if !os.IsNotExist(err) {
				return err
			}
		} else {
			attrs, ok := st.Sys().(*syscall.Win32FileAttributeData)
			if !st.IsDir() || !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return errors.New("legacy path contains a reparse point")
			}
			if recursive {
				if err = validatePermissions(p, p != root); err != nil {
					return err
				}
			}
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if !recursive {
		return nil
	}
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		st, err := entry.Info()
		if err != nil {
			return err
		}
		attrs, ok := st.Sys().(*syscall.Win32FileAttributeData)
		if !ok || attrs.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("legacy tree contains a reparse point")
		}
		if st.IsDir() {
			return validatePermissions(path, false)
		}
		if !st.Mode().IsRegular() {
			return errors.New("legacy tree contains a nonregular file")
		}
		return nil
	})
}
func (l *legacyInstallation) verifySource() error {
	if err := legacyInstallationRoot(l.root); err != nil {
		return err
	}
	if err := legacySafeTree(l.root, true); err != nil {
		return err
	}
	if err := l.verifyInventory(); err != nil {
		return err
	}
	files := []struct{ name, digest string }{{legacyUninstaller, l.policy.UninstallerSHA256}, {`resources\product.json`, l.policy.ProductSHA256}, {`resources\app.asar`, l.policy.AsarSHA256}}
	for _, item := range files {
		file, err := holdPayload(filepath.Join(l.root, item.name))
		if err != nil {
			return err
		}
		err = verifyLegacyDigest(file, item.digest)
		if err == nil && item.name == `resources\product.json` {
			if _, err = file.Seek(0, io.SeekStart); err == nil {
				var data []byte
				data, err = io.ReadAll(io.LimitReader(file, legacyProductLimit+1))
				if len(data) > legacyProductLimit {
					err = errLegacyUnsupported
				}
				if err == nil {
					err = verifyLegacyProduct(data)
				}
			}
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
func (l *legacyInstallation) unchanged() error {
	home, err := readLegacyEnvironment(syscall.HKEY_CURRENT_USER, `Environment`)
	if err != nil {
		return err
	}
	machine, err := readLegacyEnvironment(syscall.HKEY_LOCAL_MACHINE, legacyMachineEnvironment)
	if err != nil {
		return err
	}
	value, exists := os.LookupEnv(legacyHomeName)
	if !l.home.equal(home) || !l.machineHome.equal(machine) || value != l.processHome || exists != l.processHomeExists {
		return errLegacyChanged
	}
	return nil
}
func (l *legacyInstallation) preflight(destination string) error {
	if l == nil {
		return nil
	}
	if err := l.unchanged(); err != nil {
		return err
	}
	old, err := canonicalDirectory(l.root)
	if err != nil {
		return err
	}
	target, err := canonicalDirectory(destination)
	if err != nil {
		return err
	}
	if legacyOverlap(old, target) {
		return errors.New("choose a new installation directory outside the legacy installation")
	}
	for _, home := range l.homes {
		if err = legacySafeTree(home, false); err != nil {
			return err
		}
		canonical, err := canonicalDirectory(home)
		if err != nil {
			return err
		}
		if legacyOverlap(canonical, old) || legacyOverlap(canonical, target) {
			return errors.New("installation directories must not overlap user data")
		}
		// The --updated hook only removes these obsolete transient directories.
		for _, relative := range []string{`runtime\staging`, `runtime\locks`} {
			if err = legacySafeTree(filepath.Join(home, relative), true); err != nil {
				return err
			}
		}
	}
	hookHome, err := l.hookHome()
	if err != nil {
		return err
	}
	hookCanonical, err := canonicalDirectory(hookHome)
	if err != nil {
		return err
	}
	if legacyOverlap(hookCanonical, target) {
		return errors.New("new installation overlaps the legacy cache cleanup path")
	}
	for _, relative := range []string{`runtime\staging`, `runtime\locks`} {
		if err = legacySafeTree(filepath.Join(hookHome, relative), true); err != nil {
			return err
		}
	}
	return l.checkProcesses()
}

// Enumerate native process identities; never ask the legacy uninstaller to
// decide whether to kill a running application. Its fallback matches the image
// name globally, so even another ScholarSeed installation must be closed first.
func (l *legacyInstallation) checkProcesses() error {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(snapshot)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	err = syscall.Process32First(snapshot, &entry)
	for err == nil {
		name := strings.ToLower(syscall.UTF16ToString(entry.ExeFile[:]))
		if name == "scholarseed.exe" {
			return errLegacyRunning
		}
		process, openErr := syscall.OpenProcess(legacyProcessQuery, false, entry.ProcessID)
		if openErr == nil {
			var path [32768]uint16
			length := uint32(len(path))
			ok, _, queryErr := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(process), 0, uintptr(unsafe.Pointer(&path[0])), uintptr(unsafe.Pointer(&length)))
			syscall.CloseHandle(process)
			if ok != 0 {
				executable := syscall.UTF16ToString(path[:length])
				roots := append([]string{l.root}, l.runtimeRoots()...)
				for _, root := range roots {
					if legacyOverlap(filepath.Clean(executable), root) {
						return errLegacyRunning
					}
				}
			} else if legacyRuntimeImage(name) && queryErr != syscall.Errno(87) {
				return errLegacyRunning
			}
		} else if legacyRuntimeImage(name) && openErr != syscall.Errno(87) {
			return errLegacyRunning
		}
		err = syscall.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		return err
	}
	return nil
}
func legacyRuntimeImage(name string) bool {
	switch name {
	case "python.exe", "pythonw.exe", "codex.exe", "node.exe", "pwsh.exe", "uv.exe":
		return true
	}
	return false
}
func (l *legacyInstallation) runtimeRoots() []string {
	var result []string
	for _, home := range l.homes {
		result = append(result, filepath.Join(home, "runtime"))
	}
	return result
}

func (l *legacyInstallation) remove(temporary, destination string) error {
	if l == nil {
		return nil
	}
	if err := l.preflight(destination); err != nil {
		return err
	}
	if err := l.verifySource(); err != nil {
		return err
	}
	for _, r := range l.registrations {
		current, err := legacyRegistry(r.hive, r.view, "")
		if err != nil {
			return err
		}
		if current == nil || !sameLegacyPath(current.root, r.root) || current.command != r.command {
			return errLegacyChanged
		}
	}
	// Copy only authenticated bytes into a private directory outside both roots.
	private, err := os.MkdirTemp(temporary, "legacy-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(private)
	if err = secureInstallation(private); err != nil {
		return err
	}
	source, err := holdPayload(filepath.Join(l.root, legacyUninstaller))
	if err != nil {
		return err
	}
	target := filepath.Join(private, legacyUninstaller)
	copied, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		source.Close()
		return err
	}
	_, copyErr := io.Copy(copied, source)
	syncErr := copied.Sync()
	closeErr := copied.Close()
	source.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	executable, err := holdPayload(target)
	if err != nil {
		return err
	}
	defer executable.Close()
	if err = verifyLegacyDigest(executable, l.policy.UninstallerSHA256); err != nil {
		return err
	}
	if err = l.unchanged(); err != nil {
		return err
	}
	if !l.machine {
		entry, lockErr := l.lockStart()
		if lockErr != nil {
			return lockErr
		}
		defer entry.Close()
	}
	if err = l.checkProcesses(); err != nil {
		return err
	}
	parameters, err := legacyArguments(l.root, l.machine)
	if err != nil {
		return err
	}
	runErr := l.runUninstaller(target, parameters, destination, private)
	// --updated does not alter Home. Never overwrite a concurrent user change on
	// failure or success; absence, raw type and bytes must all remain identical.
	environmentErr := l.unchanged()
	if runErr != nil {
		return errors.Join(runErr, environmentErr)
	}
	if environmentErr != nil {
		return environmentErr
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		retired, err := l.retired()
		if err != nil {
			return err
		}
		if retired {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("legacy uninstall exited without retiring the installation")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
func (l *legacyInstallation) retired() (bool, error) {
	for _, r := range l.registrations {
		for _, path := range []string{legacyInstallKey, uninstallKey + legacyGUID} {
			var key syscall.Handle
			err := syscall.RegOpenKeyEx(r.hive, utf(path), 0, syscall.KEY_READ|r.view, &key)
			if err == nil {
				syscall.RegCloseKey(key)
				return false, nil
			}
			if !errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
				return false, err
			}
		}
	}
	for _, name := range []string{"ScholarSeed.exe", legacyUninstaller, `resources\app.asar`} {
		_, err := os.Lstat(filepath.Join(l.root, name))
		if err == nil {
			return false, nil
		}
		if !os.IsNotExist(err) {
			return false, err
		}
	}
	return true, nil
}

type legacyShellExecuteInfo struct {
	Size       uint32
	Mask       uint32
	Window     uintptr
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	Show       int32
	Instance   uintptr
	IDList     uintptr
	Class      *uint16
	ClassKey   uintptr
	HotKey     uint32
	Icon       uintptr
	Process    syscall.Handle
}

func runLegacyUninstaller(executable, parameters string, elevate bool) error {
	if !elevate {
		command := exec.Command(executable)
		command.SysProcAttr = &syscall.SysProcAttr{CmdLine: syscall.EscapeArg(executable) + " " + parameters, HideWindow: true}
		command.Stdout, command.Stderr = os.Stdout, os.Stderr
		return command.Run()
	}
	info := legacyShellExecuteInfo{Mask: 0x40 | 0x100 | 0x400, Verb: utf("runas"), File: utf(executable), Parameters: utf(parameters), Directory: utf(filepath.Dir(executable)), Show: 0}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, err := shell.NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return fmt.Errorf("legacy uninstall elevation failed: %w", err)
	}
	if info.Process == 0 {
		return errors.New("legacy uninstall elevation returned no process handle")
	}
	defer syscall.CloseHandle(info.Process)
	wait, err := syscall.WaitForSingleObject(info.Process, legacyWaitMilliseconds)
	if err != nil {
		return err
	}
	if wait != syscall.WAIT_OBJECT_0 {
		return errors.New("legacy uninstall did not finish; do not start another migration until it exits")
	}
	var exit uint32
	if err = syscall.GetExitCodeProcess(info.Process, &exit); err != nil {
		return err
	}
	if exit == legacyIdentityExit {
		return errLegacyIdentity
	}
	if exit != 0 {
		return fmt.Errorf("legacy uninstall failed with exit code %d", exit)
	}
	return nil
}

// Only child processes need an updated environment when Explorer's block lacks
// an existing persisted Home. The user's registry and this process stay intact.
func (l *legacyInstallation) environment(base []string) []string {
	value := l.processHome
	if value == "" {
		value, _ = l.home.value()
		if value == "" {
			value, _ = l.machineHome.value()
		}
	}
	if value == "" {
		return base
	}
	result := make([]string, 0, len(base)+1)
	for _, entry := range base {
		key, _, found := strings.Cut(entry, "=")
		if !found || !strings.EqualFold(key, legacyHomeName) {
			result = append(result, entry)
		}
	}
	return append(result, legacyHomeName+"="+value)
}

// Never permit a corrupted registration to turn an OS or shared application
// container into the legacy uninstall root. Machine installs below Program
// Files remain supported; Windows and System directories never are.
func legacyInstallationRoot(root string) error {
	canonical, err := canonicalDirectory(root)
	if err != nil {
		return err
	}
	for _, id := range []uintptr{0x0024, 0x0025, 0x0026, 0x002a, 0x0023, 0x0028, 0x001c} {
		var buffer [syscall.MAX_PATH]uint16
		code, _, _ := shell.NewProc("SHGetFolderPathW").Call(0, id, 0, 0, uintptr(unsafe.Pointer(&buffer[0])))
		if code != 0 {
			return errors.New("cannot resolve legacy installation boundary")
		}
		protected, err := canonicalDirectory(syscall.UTF16ToString(buffer[:]))
		if err != nil {
			return err
		}
		if sameLegacyPath(canonical, protected) || ((id == 0x0024 || id == 0x0025) && legacyOverlap(canonical, protected)) {
			return errors.New("legacy registration points at a protected system directory")
		}
	}
	return nil
}

// NSIS ReadRegStr preserves REG_EXPAND_SZ references. Its customUnInstall hook
// runs with $OUTDIR=$INSTDIR and does not call ExpandEnvStrings. Validate those
// literal cleanup targets as well as the expanded application data directory.
func (l *legacyInstallation) hookHome() (string, error) {
	value, err := l.home.rawValue()
	if err != nil {
		return "", err
	}
	if value == "" {
		return l.homes[0], nil
	}
	if len(utf16.Encode([]rune(value))) >= 1024 {
		return "", errors.New("SCHOLARSEED_HOME exceeds the legacy uninstaller string limit")
	}
	if filepath.IsAbs(value) {
		return value, nil
	}
	if strings.ContainsAny(value, ":\x00\r\n") || strings.HasPrefix(value, `\`) || strings.HasPrefix(value, "/") {
		return "", errLegacyUnsupported
	}
	for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == '\\' || r == '/' }) {
		if part == ".." || strings.TrimRight(part, " .") != part {
			return "", errors.New("relative legacy data path is unsafe")
		}
	}
	return filepath.Join(l.root, value), nil
}

func (l *legacyInstallation) verifyInventory() error {
	if len(l.inventory) == 0 {
		return errLegacyUnsupported
	}
	files := make(map[string]legacyFile, len(l.inventory))
	directories := map[string]bool{".": true}
	for _, entry := range l.inventory {
		key := strings.ToLower(filepath.FromSlash(entry.Path))
		files[key] = entry
		for parent := filepath.Dir(key); parent != "."; parent = filepath.Dir(parent) {
			directories[parent] = true
		}
	}
	found := 0
	err := filepath.WalkDir(l.root, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(l.root, filename)
		if err != nil {
			return err
		}
		key := strings.ToLower(relative)
		if entry.IsDir() {
			if !directories[key] {
				return errors.New("legacy installation contains extra directories; user files will not be removed")
			}
			return nil
		}
		expected, ok := files[key]
		if !ok {
			return errors.New("legacy installation contains extra files; user files will not be removed")
		}
		file, err := holdPayload(filename)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err == nil && info.Size() != expected.Size {
			err = errLegacyUnsupported
		}
		if err == nil {
			err = verifyLegacyDigest(file, expected.SHA256)
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		found++
		return nil
	})
	if err != nil {
		return err
	}
	if found != len(files) {
		return errLegacyUnsupported
	}
	return nil
}

// Deny new reads/executable mappings of the old entry while allowing NSIS to
// rename and delete it. The final process check runs after acquiring this gate.
func (l *legacyInstallation) lockStart() (*os.File, error) {
	filename := filepath.Join(l.root, "ScholarSeed.exe")
	handle, err := syscall.CreateFile(utf(filename), syscall.GENERIC_READ, syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errLegacyRunning, err)
	}
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(handle, &info); err != nil {
		syscall.CloseHandle(handle)
		return nil, err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_DIRECTORY|syscall.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		syscall.CloseHandle(handle)
		return nil, errLegacyUnsupported
	}
	return os.NewFile(uintptr(handle), filename), nil
}
