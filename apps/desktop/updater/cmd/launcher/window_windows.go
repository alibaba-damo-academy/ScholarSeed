package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"scholarseed.local/desktop/updater/handoff"
)

const (
	wmClose      = 0x0010
	wmInitDialog = 0x0110
	wmCommand    = 0x0111
	wmProgress   = 0x8001
	wmComplete   = 0x8002
	idCancel     = 2
	idRetry      = 4
	idStatus     = 100
	idDetail     = 101
	idBrand      = 102
	idElapsed    = 103
	wsChild      = 0x40000000
	wsVisible    = 0x10000000
	wsTabstop    = 0x00010000
)

type preparation func(context.Context, func(handoff.BootstrapProgress)) (handoff.BootstrapResult, error)
type dialogState struct {
	window   uintptr
	text     handoff.StartupMessages
	prepare  preparation
	cancel   context.CancelFunc
	mutex    sync.Mutex
	progress handoff.BootstrapProgress
	result   handoff.BootstrapResult
	err      error
	stopping bool
	failed   bool
	done     chan struct{}
	notified bool
	visual   *startupVisual
}

var activeDialog *dialogState
var callback = syscall.NewCallback(dialogProc)

func setText(window uintptr, id int, text string) {
	value, _ := syscall.UTF16PtrFromString(text)
	_, _, _ = user.NewProc("SetDlgItemTextW").Call(window, uintptr(id), uintptr(unsafe.Pointer(value)))
}
func item(window uintptr, id int) uintptr {
	control, _, _ := user.NewProc("GetDlgItem").Call(window, uintptr(id))
	return control
}
func visible(window uintptr, id int, show bool) {
	flag := uintptr(0)
	if show {
		flag = 5
	}
	_, _, _ = user.NewProc("ShowWindow").Call(item(window, id), flag)
}
func enabled(window uintptr, id int, enable bool) {
	flag := uintptr(0)
	if enable {
		flag = 1
	}
	_, _, _ = user.NewProc("EnableWindow").Call(item(window, id), flag)
}

func (state *dialogState) begin() {
	state.stopping, state.failed = false, false
	if state.visual != nil {
		state.visual.started = time.Now()
	}
	if state.window != 0 {
		setText(state.window, idStatus, state.text.Preparing)
		setText(state.window, idCancel, state.text.Cancel)
		visible(state.window, idRetry, false)
		visible(state.window, idDetail, false)
		enabled(state.window, idCancel, true)
		visible(state.window, idCancel, false)
		state.layout()
	}
	state.done = make(chan struct{})
	state.mutex.Lock()
	state.notified = false
	state.err = nil
	state.progress = handoff.BootstrapProgress{Phase: handoff.BootstrapChecking}
	state.mutex.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), handoff.WorkerWait)
	state.cancel = cancel
	go func() {
		result, err := state.prepare(ctx, func(progress handoff.BootstrapProgress) {
			state.mutex.Lock()
			state.progress = progress
			window := state.window
			state.mutex.Unlock()
			if window != 0 {
				_, _, _ = user.NewProc("PostMessageW").Call(window, wmProgress, 0, 0)
			}
		})
		cancel()
		state.mutex.Lock()
		state.result, state.err = result, err
		state.mutex.Unlock()
		close(state.done)
		state.postCompletion()
	}()
}

func (state *dialogState) postCompletion() {
	state.mutex.Lock()
	window := state.window
	post := window != 0 && !state.notified
	if post {
		state.notified = true
	}
	state.mutex.Unlock()
	if post {
		_, _, _ = user.NewProc("PostMessageW").Call(window, wmComplete, 0, 0)
	}
}

func (state *dialogState) stop() {
	if state.failed {
		_, _, _ = user.NewProc("EndDialog").Call(state.window, idCancel)
		return
	}
	state.stopping = true
	state.cancel()
	setText(state.window, idStatus, state.text.Stopping)
	enabled(state.window, idCancel, false)
}

func dialogProc(window uintptr, message uint32, wparam, lparam uintptr) uintptr {
	state := activeDialog
	if state == nil {
		return 0
	}
	switch message {
	case wmInitDialog:
		state.mutex.Lock()
		state.window = window
		state.mutex.Unlock()
		state.visual = newStartupVisual(window)
		state.layout()
		select {
		case <-state.done:
			state.postCompletion()
		default:
			_, _, _ = user.NewProc("PostMessageW").Call(window, wmProgress, 0, 0)
		}
		return 1
	case wmTimer:
		state.tick()
		return 1
	case wmPaint:
		state.paint()
		return 1
	case wmColorDialog, wmColorStatic:
		if state.visual == nil {
			return 0
		}
		color := uintptr(startupSecondary)
		if lparam == item(window, idBrand) {
			color = startupPrimary
		}
		gdi.NewProc("SetTextColor").Call(wparam, color)
		gdi.NewProc("SetBkColor").Call(wparam, startupBackground)
		return state.visual.background
	case wmDestroy:
		if state.visual != nil {
			state.visual.close(window)
		}
		return 1
	case wmClose:
		state.stop()
		return 1
	case wmCommand:
		switch int(wparam & 0xffff) {
		case idCancel:
			state.stop()
			return 1
		case idRetry:
			if state.failed {
				state.begin()
			}
			return 1
		}
	case wmProgress:
		if state.stopping {
			return 1
		}
		state.mutex.Lock()
		progress := state.progress
		state.mutex.Unlock()
		text := state.text.Preparing
		if progress.Phase == handoff.BootstrapVerifying {
			text = state.text.Verifying
		}
		if progress.Phase == handoff.BootstrapDownloading || (progress.Phase == handoff.BootstrapPreparing && progress.Total > 0 && state.text.Extracting != "") {
			percent := int64(0)
			if progress.Total > 0 {
				percent = progress.Received * 100 / progress.Total
			}
			template := state.text.Downloading
			if progress.Phase == handoff.BootstrapPreparing {
				template = state.text.Extracting
			}
			text = strings.NewReplacer("{{name}}", "Electron", "{{percent}}", fmt.Sprint(percent)).Replace(template)
		}
		setText(window, idStatus, text)
		return 1
	case wmComplete:
		state.mutex.Lock()
		err := state.err
		state.mutex.Unlock()
		if state.stopping || errors.Is(err, context.Canceled) {
			_, _, _ = user.NewProc("EndDialog").Call(window, idCancel)
			return 1
		}
		if err == nil {
			_, _, _ = user.NewProc("EndDialog").Call(window, 1)
			return 1
		}
		state.failed = true
		state.layout()
		setText(window, idStatus, state.text.Failed)
		setText(window, idDetail, err.Error())
		setText(window, idCancel, state.text.Exit)
		visible(window, idDetail, true)
		visible(window, idRetry, true)
		visible(window, idCancel, true)
		_, _, _ = user.NewProc("SetFocus").Call(item(window, idRetry))
		return 1
	}
	return 0
}

// A native modal dialog exists before Electron is available. Windows owns its
// font, keyboard traversal and standard controls; application strings originate
// exclusively in the frozen Desktop localization resources.
func prepareWindow(messages map[string]handoff.StartupMessages, prepare func(context.Context, func(handoff.BootstrapProgress)) (handoff.BootstrapResult, error)) (handoff.BootstrapResult, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	state := &dialogState{text: uiMessages(messages), prepare: prepare}
	state.begin()
	// A warm, validated launch normally finishes before any native window is
	// necessary. Slow checks/downloads use the same in-flight operation and policy.
	select {
	case <-state.done:
		state.mutex.Lock()
		result, err := state.result, state.err
		state.mutex.Unlock()
		if err == nil {
			return result, nil
		}
	case <-time.After(300 * time.Millisecond):
	}
	activeDialog = state
	defer func() {
		if state.cancel != nil {
			state.cancel()
		}
		activeDialog = nil
	}()
	template := dialogTemplate(state.text)
	instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
	result, _, callErr := user.NewProc("DialogBoxIndirectParamW").Call(instance, uintptr(unsafe.Pointer(&template[0])), 0, callback, 0)
	runtime.KeepAlive(template)
	if result == ^uintptr(0) {
		return handoff.BootstrapResult{}, fmt.Errorf("startup dialog failed: %w", callErr)
	}
	state.mutex.Lock()
	defer state.mutex.Unlock()
	if result != 1 {
		if state.err != nil {
			return handoff.BootstrapResult{}, state.err
		}
		return handoff.BootstrapResult{}, context.Canceled
	}
	return state.result, state.err
}

func dialogTemplate(text handoff.StartupMessages) []byte {
	var output []byte
	word := func(value uint16) { output = binary.LittleEndian.AppendUint16(output, value) }
	dword := func(value uint32) { output = binary.LittleEndian.AppendUint32(output, value) }
	str := func(value string) {
		for _, value := range utf16.Encode([]rune(value)) {
			word(value)
		}
		word(0)
	}
	dword(0x80ca08c0) // popup, caption, system menu, modal frame, centered, set font
	dword(0)
	word(6)
	word(0)
	word(0)
	word(344)
	word(164)
	word(0)
	word(0)
	str(text.Title)
	word(9)
	str("Segoe UI")
	control := func(style uint32, x, y, width, height, id, kind uint16, label string) {
		for len(output)%4 != 0 {
			output = append(output, 0)
		}
		dword(style)
		dword(0)
		word(x)
		word(y)
		word(width)
		word(height)
		word(id)
		word(0xffff)
		word(kind)
		str(label)
		word(0)
	}
	control(wsChild|wsVisible|1, 12, 12, 320, 36, idStatus, 0x82, text.Preparing)
	control(wsChild|wsVisible|1, 12, 12, 320, 36, idBrand, 0x82, text.Brand)
	control(wsChild|wsVisible|1, 12, 12, 320, 36, idElapsed, 0x82, text.Elapsed)
	control(wsChild|0x00a00844, 12, 50, 320, 70, idDetail, 0x81, "") // readonly multiline scrolling details
	control(wsChild|wsTabstop, 200, 134, 62, 18, idRetry, 0x80, text.Retry)
	control(wsChild|wsTabstop, 270, 134, 62, 18, idCancel, 0x80, text.Cancel)
	return output
}
