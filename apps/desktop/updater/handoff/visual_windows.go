package handoff

import (
	"bytes"
	_ "embed"
	"fmt"
	"image/png"
	"syscall"
	"time"
	"unsafe"
)

// Rasterized at 4x from src/renderer/src/assets/logo.svg; retain its transparent
// canvas. This embedded asset is available before any runtime has downloaded.
//
//go:embed logo.png
var startupLogo []byte

// Windows startup presentation mirrors src/main/startup.ts in logical pixels.
const (
	wmPaint              = 0x000f
	wmDestroy            = 0x0002
	wmTimer              = 0x0113
	wmColorDialog        = 0x0136
	wmColorStatic        = 0x0138
	startupBackground    = 0x00f5f8f8
	startupPrimary       = 0x00161717
	startupSecondary     = 0x00494d4d
	startupTrack         = 0x00dbdede
	startupAccent        = 0x00b6aa8f
	startupWidth         = 440
	startupHeight        = 330
	startupFailureHeight = 430
	startupTimer         = 1
	startupFrame         = 30
	startupPeriod        = 1350 * time.Millisecond
)

var gdi = syscall.NewLazyDLL("gdi32.dll")

type visualRect struct{ Left, Top, Right, Bottom int32 }
type visualPaint struct {
	DC              uintptr
	Erase           int32
	Rect            visualRect
	Restore, Update int32
	Reserved        [32]byte
}
type bitmapHeader struct {
	Size                   uint32
	Width, Height          int32
	Planes, Bits           uint16
	Compression, ImageSize uint32
	XPels, YPels           int32
	Used, Important        uint32
}
type startupVisual struct {
	lastElapsed                              string
	background, track, accent, font, heading uintptr
	dpi                                      int32
	started                                  time.Time
	motion                                   bool
	pixels                                   []byte
	bitmap                                   bitmapHeader
}

func (v *startupVisual) scale(value int32) int32 { return (value*v.dpi + 48) / 96 }
func nativeText(text string) *uint16             { p, _ := syscall.UTF16PtrFromString(text); return p }
func newStartupVisual(window uintptr) *startupVisual {
	v := &startupVisual{dpi: 96, started: time.Now()}
	dpi := user.NewProc("GetDpiForWindow")
	if dpi.Find() == nil {
		if n, _, _ := dpi.Call(window); n > 0 {
			v.dpi = int32(n)
		}
	}
	v.background, _, _ = gdi.NewProc("CreateSolidBrush").Call(startupBackground)
	v.track, _, _ = gdi.NewProc("CreateSolidBrush").Call(startupTrack)
	v.accent, _, _ = gdi.NewProc("CreateSolidBrush").Call(startupAccent)
	face := nativeText("Segoe UI")
	v.font, _, _ = gdi.NewProc("CreateFontW").Call(uintptr(-v.scale(14)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(face)))
	v.heading, _, _ = gdi.NewProc("CreateFontW").Call(uintptr(-v.scale(20)), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(face)))
	for _, id := range []int{idStatus, idElapsed, idDetail, idCancel, idRetry} {
		user.NewProc("SendMessageW").Call(item(window, id), 0x30, v.font, 1)
	}
	user.NewProc("SendMessageW").Call(item(window, idBrand), 0x30, v.heading, 1)
	instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
	icon, _, _ := user.NewProc("LoadIconW").Call(instance, 1)
	if icon != 0 {
		for _, size := range []uintptr{0, 1} {
			user.NewProc("SendMessageW").Call(window, 0x80, size, icon)
		}
	}
	var motion int32
	user.NewProc("SystemParametersInfoW").Call(0x1042, 0, uintptr(unsafe.Pointer(&motion)), 0)
	v.motion = motion != 0
	if img, err := png.Decode(bytes.NewReader(startupLogo)); err == nil {
		b := img.Bounds()
		v.bitmap = bitmapHeader{Size: 40, Width: int32(b.Dx()), Height: -int32(b.Dy()), Planes: 1, Bits: 32}
		v.pixels = make([]byte, b.Dx()*b.Dy()*4)
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				r, g, b, a := img.At(x, y).RGBA()
				i := (y*int(v.bitmap.Width) + x) * 4
				// RGBA returns premultiplied channels; composite on the startup surface.
				v.pixels[i] = byte((b + 0xf5*(0xffff-a)/0xff) >> 8)
				v.pixels[i+1] = byte((g + 0xf8*(0xffff-a)/0xff) >> 8)
				v.pixels[i+2] = byte((r + 0xf8*(0xffff-a)/0xff) >> 8)
			}
		}
	}
	user.NewProc("SetTimer").Call(window, startupTimer, startupFrame, 0)
	return v
}
func (v *startupVisual) close(window uintptr) {
	user.NewProc("KillTimer").Call(window, startupTimer)
	for _, handle := range []uintptr{v.background, v.track, v.accent, v.font, v.heading} {
		if handle != 0 {
			gdi.NewProc("DeleteObject").Call(handle)
		}
	}
}
func (state *dialogState) layout() {
	v := state.visual
	if v == nil {
		return
	}
	window := state.window
	// WM_INITDIALOG runs before the asynchronous owner sees the HWND.
	height := int32(startupHeight)
	if state.failed {
		height = startupFailureHeight
	}
	var work visualRect
	user.NewProc("SystemParametersInfoW").Call(0x30, 0, uintptr(unsafe.Pointer(&work)), 0)
	w, h := v.scale(startupWidth), v.scale(height)
	// Keep both the compact progress and expanded failure state centered.
	flags := uintptr(0x0014)
	user.NewProc("SetWindowPos").Call(window, 0, uintptr(work.Left+(work.Right-work.Left-w)/2), uintptr(work.Top+(work.Bottom-work.Top-h)/2), uintptr(w), uintptr(h), flags)
	var client visualRect
	user.NewProc("GetClientRect").Call(window, uintptr(unsafe.Pointer(&client)))
	move := func(id int, x, y, w, h int32) {
		user.NewProc("MoveWindow").Call(item(window, id), uintptr(v.scale(x)), uintptr(v.scale(y)), uintptr(w), uintptr(v.scale(h)), 1)
	}
	content := client.Right - v.scale(64)
	move(idBrand, 32, 92, content, 30)
	move(idStatus, 32, 138, content, 52)
	move(idElapsed, 32, 230, content, 24)
	move(idDetail, 32, 196, content, 100)
	move(idRetry, 220, 324, v.scale(80), 26)
	move(idCancel, 308, 324, v.scale(80), 26)
	visible(window, idElapsed, !state.failed)
	user.NewProc("InvalidateRect").Call(window, 0, 1)
	state.tick()
}
func (state *dialogState) tick() {
	if state.visual == nil {
		return
	}
	v := state.visual
	if !state.failed {
		elapsed := fmt.Sprintf("%s %ds", state.text.Elapsed, int(time.Since(v.started).Seconds()))
		if elapsed != v.lastElapsed {
			setText(state.window, idElapsed, elapsed)
			v.lastElapsed = elapsed
		}
	}
	var client visualRect
	user.NewProc("GetClientRect").Call(state.window, uintptr(unsafe.Pointer(&client)))
	rect := visualRect{(client.Right - v.scale(154)) / 2, v.scale(206), (client.Right + v.scale(154)) / 2, v.scale(209)}
	user.NewProc("InvalidateRect").Call(state.window, uintptr(unsafe.Pointer(&rect)), 0)
}
func (state *dialogState) paint() {
	v := state.visual
	if v == nil {
		return
	}
	var paint visualPaint
	dc, _, _ := user.NewProc("BeginPaint").Call(state.window, uintptr(unsafe.Pointer(&paint)))
	if dc == 0 {
		return
	}
	defer user.NewProc("EndPaint").Call(state.window, uintptr(unsafe.Pointer(&paint)))
	user.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&paint.Rect)), v.background)
	var client visualRect
	user.NewProc("GetClientRect").Call(state.window, uintptr(unsafe.Pointer(&client)))
	if len(v.pixels) > 0 {
		size := v.scale(46)
		gdi.NewProc("SetStretchBltMode").Call(dc, 4)
		gdi.NewProc("StretchDIBits").Call(dc, uintptr((client.Right-size)/2), uintptr(v.scale(30)), uintptr(size), uintptr(size), 0, 0, uintptr(v.bitmap.Width), uintptr(-v.bitmap.Height), uintptr(unsafe.Pointer(&v.pixels[0])), uintptr(unsafe.Pointer(&v.bitmap)), 0, 0x00cc0020)
	}
	if state.failed {
		return
	}
	rect := visualRect{(client.Right - v.scale(154)) / 2, v.scale(206), (client.Right + v.scale(154)) / 2, v.scale(209)}
	user.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&rect)), v.track)
	segment := rect
	width := rect.Right - rect.Left
	sw := width * 42 / 100
	if v.motion && !state.stopping {
		segment.Left += int32(int64(width+sw)*int64(time.Since(v.started)%startupPeriod)/int64(startupPeriod)) - sw
	}
	segment.Right = min(rect.Right, segment.Left+sw)
	segment.Left = max(rect.Left, segment.Left)
	state.mutex.Lock()
	progress := state.progress
	state.mutex.Unlock()
	if (progress.Phase == BootstrapDownloading || progress.Phase == BootstrapPreparing) && progress.Total > 0 {
		segment.Left = rect.Left
		segment.Right = rect.Left + int32(int64(width)*min(progress.Total, max(int64(0), progress.Received))/progress.Total)
	}
	user.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&segment)), v.accent)
}
