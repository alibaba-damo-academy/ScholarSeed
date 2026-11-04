package main

import (
	"context"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"scholarseed.local/desktop/updater/handoff"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var user = syscall.NewLazyDLL("user32.dll")

func prepareWindow(messages map[string]handoff.StartupMessages, prepare func(context.Context, func(handoff.BootstrapProgress)) (handoff.BootstrapResult, error)) (handoff.BootstrapResult, error) {
	return handoff.PrepareWindow(uiMessages(messages), prepare)
}

func uiMessages(messages map[string]handoff.StartupMessages) handoff.StartupMessages {
	language, _, _ := kernel.NewProc("GetUserDefaultUILanguage").Call()
	if language&0x3ff == 4 {
		return messages["zh"]
	}
	return messages["en"]
}

func showFailure(messages map[string]handoff.StartupMessages, err error) {
	text := uiMessages(messages)
	title, _ := syscall.UTF16PtrFromString(text.Title)
	body, _ := syscall.UTF16PtrFromString(text.Failed + "\r\n\r\n" + err.Error())
	_, _, _ = user.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x10)
}

func engineEnvironment() []string {
	environment := os.Environ()
	get := kernel.NewProc("GetEnvironmentVariableW")
	// The official Rust SDK updates the native environment after Go has cached
	// os.Environ. Preserve its first-run/restart markers explicitly in the child.
	for _, name := range []string{"VELOPACK_FIRSTRUN", "VELOPACK_RESTART"} {
		key, _ := syscall.UTF16PtrFromString(name)
		buffer := make([]uint16, 32768)
		n, _, _ := get.Call(uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if n == 0 || n >= uintptr(len(buffer)) {
			continue
		}
		for i := len(environment) - 1; i >= 0; i-- {
			if strings.HasPrefix(strings.ToUpper(environment[i]), name+"=") {
				environment = append(environment[:i], environment[i+1:]...)
			}
		}
		environment = append(environment, name+"="+syscall.UTF16ToString(buffer[:n]))
	}
	return environment
}
