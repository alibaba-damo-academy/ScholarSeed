package handoff

import (
	"bufio"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

//go:embed retirement.ps1
var retirementScript string

const retirementWait = 60 * time.Second
const retirementStartup = 10 * time.Second

func prepareRetirement(current string) error {
	if filepath.Base(current) != "current" {
		return errors.New("retirement requires installed current")
	}
	root := filepath.Dir(current)
	parent, err := openProcessWaiter(uint32(os.Getppid()))
	if err != nil {
		return err
	}
	defer parent.Close()
	process := parent.(*windowsWaiter)
	var image [32768]uint16
	length := uint32(len(image))
	ok, _, callErr := kernel.NewProc("QueryFullProcessImageNameW").Call(uintptr(process.handle), 0, uintptr(unsafe.Pointer(&image[0])), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return callErr
	}
	if !strings.EqualFold(syscall.UTF16ToString(image[:length]), filepath.Join(root, "Update.exe")) || !process.Alive() {
		return errors.New("retirement requires this installation's live updater parent")
	}
	command, err := startRetirement(root, process.handle)
	if err != nil {
		return err
	}
	return command.Process.Release()
}

// Pin the final two objects until their owner exits. The official updater still
// removes all application contents; only its image and empty root are handed off.
func startRetirement(root string, process syscall.Handle) (*exec.Cmd, error) {
	parents, err := pinLineage(filepath.Dir(root))
	if err != nil {
		return nil, err
	}
	defer closeFiles(parents)
	directory, err := pinDirectorySharing(root, 0x80, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	name, err := syscall.UTF16PtrFromString(filepath.Join(root, "Update.exe"))
	if err != nil {
		return nil, err
	}
	image, err := syscall.CreateFile(name, 0x80, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(image)
	var info syscall.ByHandleFileInformation
	if err = syscall.GetFileInformationByHandle(image, &info); err != nil {
		return nil, err
	}
	if info.NumberOfLinks != 1 || info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return nil, errors.New("retirement updater is not an unlinked regular file")
	}
	self, err := syscall.GetCurrentProcess()
	if err != nil {
		return nil, err
	}
	var inherited []syscall.Handle
	defer func() {
		for _, handle := range inherited {
			syscall.CloseHandle(handle)
		}
	}()
	originals := []syscall.Handle{process, image, syscall.Handle(directory.Fd())}
	for _, parent := range parents {
		originals = append(originals, syscall.Handle(parent.Fd()))
	}
	for _, original := range originals {
		var duplicate syscall.Handle
		if err = syscall.DuplicateHandle(self, original, self, &duplicate, 0, true, syscall.DUPLICATE_SAME_ACCESS); err != nil {
			return nil, err
		}
		inherited = append(inherited, duplicate)
	}
	var buffer [32768]uint16
	n, _, callErr := kernel.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if n == 0 || n >= uintptr(len(buffer)) {
		return nil, callErr
	}
	system := syscall.UTF16ToString(buffer[:n])
	script := retirementScript + fmt.Sprintf("\nInvoke-Retirement %d %d %d %d\n", inherited[0], inherited[1], inherited[2], retirementWait/time.Millisecond)
	words := utf16.Encode([]rune(script))
	bytes := make([]byte, len(words)*2)
	for i, word := range words {
		bytes[i*2], bytes[i*2+1] = byte(word), byte(word>>8)
	}
	command := exec.Command(filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(bytes))
	command.Dir = system
	command.Env = []string{"SystemRoot=" + filepath.Dir(system), "WINDIR=" + filepath.Dir(system), "PATH=" + system, "PSModulePath=" + filepath.Join(system, "WindowsPowerShell", "v1.0", "Modules")}
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, AdditionalInheritedHandles: inherited}
	command.Stderr = os.Stderr
	output, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	defer output.Close()
	if err = command.Start(); err != nil {
		return nil, err
	}
	ready := make(chan error, 1)
	go func() {
		line, readErr := bufio.NewReader(output).ReadString('\n')
		if readErr == nil && strings.TrimSpace(line) != "ready" {
			readErr = errors.New("invalid retirement readiness")
		}
		ready <- readErr
	}()
	select {
	case err = <-ready:
	case <-time.After(retirementStartup):
		err = errors.New("retirement startup timeout")
	}
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, fmt.Errorf("retirement startup: %w", err)
	}
	return command, nil
}
