package main

import (
	_ "embed"
	"encoding/json"
	"syscall"
	"unsafe"
)

//go:embed messages.json
var messages []byte

func showError(err error) {
	var text map[string]struct {
		Title  string
		Failed string
	}
	if json.Unmarshal(messages, &text) != nil {
		return
	}
	language, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage").Call()
	key := "en"
	if language&0x3ff == 4 {
		key = "zh"
	}
	title, _ := syscall.UTF16PtrFromString(text[key].Title)
	body, _ := syscall.UTF16PtrFromString(text[key].Failed + "\r\n\r\n" + err.Error())
	_, _, _ = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x10)
}
