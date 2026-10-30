package main

import (
	"encoding/binary"
	"fmt"
	"path/filepath"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var user = syscall.NewLazyDLL("user32.dll")
var shell = syscall.NewLazyDLL("shell32.dll")
var kernel = syscall.NewLazyDLL("kernel32.dll")
var ole = syscall.NewLazyDLL("ole32.dll")

const (
	wmInit        = 0x0110
	wmCommand     = 0x0111
	wmClose       = 0x0010
	idInstall     = 1
	idCancel      = 2
	idDirectory   = 100
	idBrowse      = 101
	idHeading     = 102
	idDescription = 103
	wsChild       = 0x40000000
	wsVisible     = 0x10000000
	wsTabstop     = 0x00010000
)

type choice struct {
	config              configuration
	text                messages
	directory, existing string
	accepted            bool
	visual              *setupVisual
	operation           func() error
	completion          chan error
	failure             error
}

var activeChoice *choice
var choiceCallback = syscall.NewCallback(choiceProc)

func utf(value string) *uint16 { p, _ := syscall.UTF16PtrFromString(value); return p }
func localized(messages map[string]messages) messages {
	language, _, _ := kernel.NewProc("GetUserDefaultUILanguage").Call()
	if language&0x3ff == 4 {
		return messages["zh"]
	}
	return messages["en"]
}
func showError(title, body string) {
	user.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf(body))), uintptr(unsafe.Pointer(utf(title))), 0x10)
}

func retryLegacy(title, body string) bool {
	const warningRetryCancel = 0x00000035
	const answerRetry = 4
	answer, _, _ := user.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf(body))), uintptr(unsafe.Pointer(utf(title))), warningRetryCancel)
	return answer == answerRetry
}

func confirmDirectoryRisk(title, body string) bool {
	const warningYesNoDefaultNo = 0x00000134
	const answerYes = 6
	answer, _, _ := user.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf(body))), uintptr(unsafe.Pointer(utf(title))), warningYesNoDefaultNo)
	return answer == answerYes
}
func control(window uintptr, id int) uintptr {
	h, _, _ := user.NewProc("GetDlgItem").Call(window, uintptr(id))
	return h
}
func setControlText(window uintptr, id int, value string) {
	user.NewProc("SetDlgItemTextW").Call(window, uintptr(id), uintptr(unsafe.Pointer(utf(value))))
}
func readDirectory(window uintptr) string {
	var data [32768]uint16
	user.NewProc("GetDlgItemTextW").Call(window, idDirectory, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)))
	return syscall.UTF16ToString(data[:])
}
func choiceProc(window uintptr, message uint32, wparam, lparam uintptr) uintptr {
	state := activeChoice
	if state == nil {
		return 0
	}
	switch message {
	case wmInit:
		state.visual = newSetupVisual(window)
		setControlText(window, idDirectory, state.directory)
		if state.existing != "" {
			setControlText(window, idDescription, state.text.Existing)
			user.NewProc("SendMessageW").Call(control(window, idDirectory), 0x00cf, 1, 0) // EM_SETREADONLY
			user.NewProc("EnableWindow").Call(control(window, idBrowse), 0)
		}
		instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
		icon, _, _ := user.NewProc("LoadIconW").Call(instance, 1)
		if icon != 0 {
			user.NewProc("SendMessageW").Call(window, 0x80, 0, icon)
			user.NewProc("SendMessageW").Call(window, 0x80, 1, icon)
		}
		if state.operation != nil {
			setControlText(window, idHeading, state.text.Installing)
			setControlText(window, idDescription, state.text.Preparing)
			for _, id := range []int{idDirectory, idBrowse, idInstall, idCancel} {
				user.NewProc("EnableWindow").Call(control(window, id), 0)
			}
			go func() { state.completion <- state.operation(); user.NewProc("PostMessageW").Call(window, 0x8001, 0, 0) }()
		}
		return 1
	case 0x8001:
		if state.operation != nil {
			state.failure = <-state.completion
			user.NewProc("EndDialog").Call(window, 1)
			return 1
		}
	case 0x000f:
		if state.visual != nil {
			state.visual.paint(window)
			return 1
		}
	case 0x0136, 0x0138:
		if state.visual != nil {
			gdi.NewProc("SetBkColor").Call(wparam, setupBackground)
			gdi.NewProc("SetTextColor").Call(wparam, 0x00494d4d)
			return state.visual.background
		}
	case 0x0002:
		if state.visual != nil {
			state.visual.close()
			state.visual = nil
		}
	case wmClose:
		if state.operation != nil {
			return 1
		}
		user.NewProc("EndDialog").Call(window, idCancel)
		return 1
	case wmCommand:
		if state.operation != nil {
			return 1
		}
		switch int(wparam & 0xffff) {
		case idCancel:
			user.NewProc("EndDialog").Call(window, idCancel)
			return 1
		case idBrowse:
			if state.existing != "" {
				return 1
			}
			if path := browse(window, state.text.Directory); path != "" {
				setControlText(window, idDirectory, path)
			}
			return 1
		case idInstall:
			path := readDirectory(window)
			// Return to the coordinator before waiting: nested dialogs would
			// overwrite activeChoice and directory pins would prevent cleanup.
			removing := false
			if filepath.IsAbs(path) {
				removal, err := inspectRemoval(path, state.config.AppID)
				removing = err == nil && (removal.active || removal.incomplete)
			}
			if err := validateDirectory(path, state.existing, state.config); err != nil && !removing {
				user.NewProc("MessageBoxW").Call(window, uintptr(unsafe.Pointer(utf(state.text.Invalid+"\n\n"+directoryError(state.text, err)))), uintptr(unsafe.Pointer(utf(state.text.Title))), 0x10)
				return 1
			}
			state.directory = path
			state.accepted = true
			user.NewProc("EndDialog").Call(window, idInstall)
			return 1
		}
	}
	return 0
}

type browseInfo struct {
	Owner, Root         uintptr
	Display             *uint16
	Title               *uint16
	Flags               uint32
	Callback, Parameter uintptr
	Image               int32
}

func browse(owner uintptr, title string) string {
	var display, path [syscall.MAX_PATH]uint16
	info := browseInfo{Owner: owner, Display: &display[0], Title: utf(title), Flags: 0x0001 | 0x0040} // filesystem folders, new dialog
	pidl, _, _ := shell.NewProc("SHBrowseForFolderW").Call(uintptr(unsafe.Pointer(&info)))
	if pidl == 0 {
		return ""
	}
	defer ole.NewProc("CoTaskMemFree").Call(pidl)
	ok, _, _ := shell.NewProc("SHGetPathFromIDListW").Call(pidl, uintptr(unsafe.Pointer(&path[0])))
	if ok == 0 {
		return ""
	}
	return syscall.UTF16ToString(path[:])
}
func chooseDirectory(c configuration, text messages, directory, existing string) (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := ole.NewProc("CoInitializeEx").Call(0, 2)
	if int32(result) < 0 {
		return "", false, fmt.Errorf("folder picker initialization failed: %#x", result)
	}
	defer ole.NewProc("CoUninitialize").Call()
	state := &choice{config: c, text: text, directory: directory, existing: existing}
	activeChoice = state
	defer func() { activeChoice = nil }()
	data := choiceTemplate(text)
	instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
	result, _, err := user.NewProc("DialogBoxIndirectParamW").Call(instance, uintptr(unsafe.Pointer(&data[0])), 0, choiceCallback, 0)
	runtime.KeepAlive(data)
	if result == ^uintptr(0) {
		return "", false, fmt.Errorf("installer window failed: %w", err)
	}
	return state.directory, state.accepted, nil
}
func choiceTemplate(text messages) []byte {
	var output []byte
	word := func(value uint16) { output = binary.LittleEndian.AppendUint16(output, value) }
	dword := func(value uint32) { output = binary.LittleEndian.AppendUint32(output, value) }
	str := func(value string) {
		for _, v := range utf16.Encode([]rune(value)) {
			word(v)
		}
		word(0)
	}
	dword(0x80c808c0)
	dword(0)
	word(7)
	word(0)
	word(0)
	word(360)
	word(240)
	word(0)
	word(0)
	str(text.Title)
	word(10)
	str("Segoe UI")
	control := func(style uint32, x, y, w, h, id, kind uint16, label string) {
		for len(output)%4 != 0 {
			output = append(output, 0)
		}
		dword(style)
		dword(0)
		word(x)
		word(y)
		word(w)
		word(h)
		word(id)
		word(0xffff)
		word(kind)
		str(label)
		word(0)
	}
	control(wsChild|wsVisible|1, 18, 66, 324, 24, idHeading, 0x82, text.Heading)
	control(wsChild|wsVisible|1, 24, 100, 312, 32, idDescription, 0x82, text.Description)
	control(wsChild|wsVisible, 24, 146, 312, 12, 104, 0x82, text.Directory)
	control(wsChild|wsVisible|wsTabstop|0x00800080, 24, 162, 244, 22, idDirectory, 0x81, "")
	control(wsChild|wsVisible|wsTabstop, 276, 162, 60, 22, idBrowse, 0x80, text.Browse)
	control(wsChild|wsVisible|wsTabstop|1, 202, 202, 64, 24, idInstall, 0x80, text.Install)
	control(wsChild|wsVisible|wsTabstop, 274, 202, 62, 24, idCancel, 0x80, text.Cancel)
	return output
}

func performInstallation(c configuration, text messages, directory string, operation func() error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	state := &choice{config: c, text: text, directory: directory, operation: operation, completion: make(chan error, 1)}
	activeChoice = state
	defer func() { activeChoice = nil }()
	data := choiceTemplate(text)
	instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
	result, _, err := user.NewProc("DialogBoxIndirectParamW").Call(instance, uintptr(unsafe.Pointer(&data[0])), 0, choiceCallback, 0)
	runtime.KeepAlive(data)
	if result == ^uintptr(0) {
		return fmt.Errorf("installation progress window failed: %w", err)
	}
	return state.failure
}
