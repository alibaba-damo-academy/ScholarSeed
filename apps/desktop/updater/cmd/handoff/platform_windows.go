package main

import (
	"errors"
	"syscall"
	"unsafe"

	"scholarseed.local/desktop/updater/handoff"
)

const (
	errorDialogFlags    = 0x00000010 | 0x00010000
	primaryLanguageMask = 0x03ff
	chineseLanguage     = 0x0004
	englishMessages     = "en"
	chineseMessages     = "zh"
)

func showRecovery(messages map[string]handoff.RecoveryMessages, failure *handoff.UpdateRecoveryError) error {
	language, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage").Call()
	key := englishMessages
	if language&primaryLanguageMask == chineseLanguage {
		key = chineseMessages
	}
	text := messages[key]
	message := text.Unconfirmed
	if failure.ProcessesExited {
		message = text.Stopped
	}
	title, err := syscall.UTF16PtrFromString(text.Title)
	if err != nil {
		return err
	}
	body, err := syscall.UTF16PtrFromString(message + "\r\n\r\n" + failure.Error())
	if err != nil {
		return err
	}
	result, _, presentationErr := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(
		0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), errorDialogFlags)
	if result == 0 {
		if presentationErr != syscall.Errno(0) {
			return presentationErr
		}
		return errors.New("native update recovery dialog failed")
	}
	return nil
}
