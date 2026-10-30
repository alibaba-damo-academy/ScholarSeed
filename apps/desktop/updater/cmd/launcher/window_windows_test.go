package main

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"scholarseed.local/desktop/updater/handoff"
)

func TestNativePaintLayout(t *testing.T) {
	var p visualPaint
	if unsafe.Sizeof(p) != 72 || unsafe.Offsetof(p.Rect) != 12 {
		t.Fatal("invalid Win64 PAINTSTRUCT")
	}
	if unsafe.Sizeof(bitmapHeader{}) != 40 {
		t.Fatal("invalid bitmap header")
	}
}

// Exercises actual Win32 controls and owner cancellation. This is integration
// coverage, separate from cold-download screenshots of the product launcher.
func TestNativeRetryAndCancel(t *testing.T) {
	if os.Getenv("SCHOLARSEED_NATIVE_UI_INTEGRATION") != "1" {
		t.Skip("requires interactive Windows desktop")
	}
	text := handoff.StartupMessages{Title: "ScholarSeed native integration", Brand: "ScholarSeed", Elapsed: "Waiting:", Preparing: "Preparing", Verifying: "Verifying", Downloading: "Downloading {{name}}: {{percent}}%", Failed: "Failed", Retry: "Retry", Exit: "Exit", Stopping: "Stopping", Cancel: "Cancel"}
	var calls atomic.Int32
	var cancelled atomic.Bool
	finished := make(chan error, 1)
	go func() {
		deadline := time.Now().Add(10 * time.Second)
		var window uintptr
		for time.Now().Before(deadline) {
			window, _, _ = user.NewProc("FindWindowW").Call(0, uintptr(unsafe.Pointer(nativeText(text.Title))))
			if window != 0 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if window == 0 {
			finished <- errors.New("dialog missing")
			return
		}
		defer user.NewProc("PostMessageW").Call(window, wmClose, 0, 0)
		visibleControl := func(id int) bool { v, _, _ := user.NewProc("IsWindowVisible").Call(item(window, id)); return v != 0 }
		for !visibleControl(idRetry) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if !visibleControl(idRetry) || !visibleControl(idDetail) || !visibleControl(idCancel) {
			finished <- errors.New("failure actions missing")
			return
		}
		user.NewProc("PostMessageW").Call(window, wmCommand, idRetry, 0)
		for (calls.Load() != 2 || visibleControl(idRetry)) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if calls.Load() != 2 || visibleControl(idRetry) || visibleControl(idDetail) || visibleControl(idCancel) || !visibleControl(idElapsed) {
			finished <- errors.New("retry did not restore compact progress")
			return
		}
		// Minimize and restore are presentation-only actions.
		user.NewProc("SendMessageW").Call(window, 0x0112, 0xf020, 0)
		iconic, _, _ := user.NewProc("IsIconic").Call(window)
		if iconic == 0 || cancelled.Load() {
			finished <- errors.New("minimize changed owner lifecycle")
			return
		}
		user.NewProc("SendMessageW").Call(window, 0x0112, 0xf120, 0)
		finished <- nil
	}()
	_, err := prepareWindow(map[string]handoff.StartupMessages{"en": text, "zh": text}, func(ctx context.Context, observe func(handoff.BootstrapProgress)) (handoff.BootstrapResult, error) {
		if calls.Add(1) == 1 {
			return handoff.BootstrapResult{}, errors.New("network unavailable")
		}
		observe(handoff.BootstrapProgress{Phase: handoff.BootstrapDownloading, Received: 48, Total: 100})
		<-ctx.Done()
		cancelled.Store(true)
		return handoff.BootstrapResult{}, ctx.Err()
	})
	if e := <-finished; e != nil {
		t.Fatal(e)
	}
	if !errors.Is(err, context.Canceled) || !cancelled.Load() {
		t.Fatalf("close failed to cancel and drain owner: %v", err)
	}
}
