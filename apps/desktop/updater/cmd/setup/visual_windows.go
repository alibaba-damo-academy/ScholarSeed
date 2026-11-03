package main

import (
	"bytes"
	_ "embed"
	"image/png"
	"syscall"
	"unsafe"
)

// Same rasterized product logo and surface as the pre-runtime download window.
//
//go:embed logo.png
var setupLogo []byte

const setupBackground = 0x00f5f8f8

var gdi = syscall.NewLazyDLL("gdi32.dll")

type setupRect struct{ Left, Top, Right, Bottom int32 }
type setupPaint struct {
	DC              uintptr
	Erase           int32
	Rect            setupRect
	Restore, Update int32
	Reserved        [32]byte
}
type setupBitmap struct {
	Size                   uint32
	Width, Height          int32
	Planes, Bits           uint16
	Compression, ImageSize uint32
	XPels, YPels           int32
	Used, Important        uint32
}
type setupVisual struct {
	background, font, heading uintptr
	dpi                       int32
	pixels                    []byte
	bitmap                    setupBitmap
}

func (v *setupVisual) scale(n int32) int32 { return (n*v.dpi + 48) / 96 }
func newSetupVisual(window uintptr) *setupVisual {
	v := &setupVisual{dpi: 96}
	if p := user.NewProc("GetDpiForWindow"); p.Find() == nil {
		if n, _, _ := p.Call(window); n > 0 {
			v.dpi = int32(n)
		}
	}
	v.background, _, _ = gdi.NewProc("CreateSolidBrush").Call(setupBackground)
	face := utf("Segoe UI")
	v.font, _, _ = gdi.NewProc("CreateFontW").Call(uintptr(-v.scale(14)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(face)))
	v.heading, _, _ = gdi.NewProc("CreateFontW").Call(uintptr(-v.scale(20)), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(face)))
	for _, id := range []int{idDirectory, idBrowse, idInstall, idCancel, idDescription, 104} {
		user.NewProc("SendMessageW").Call(control(window, id), 0x30, v.font, 1)
	}
	user.NewProc("SendMessageW").Call(control(window, idHeading), 0x30, v.heading, 1)
	if img, err := png.Decode(bytes.NewReader(setupLogo)); err == nil {
		b := img.Bounds()
		v.bitmap = setupBitmap{Size: 40, Width: int32(b.Dx()), Height: -int32(b.Dy()), Planes: 1, Bits: 32}
		v.pixels = make([]byte, b.Dx()*b.Dy()*4)
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				r, g, b, a := img.At(x, y).RGBA()
				i := (y*int(v.bitmap.Width) + x) * 4
				v.pixels[i] = byte((b + 0xf5*(0xffff-a)/0xff) >> 8)
				v.pixels[i+1] = byte((g + 0xf8*(0xffff-a)/0xff) >> 8)
				v.pixels[i+2] = byte((r + 0xf8*(0xffff-a)/0xff) >> 8)
			}
		}
	}
	var work, rect setupRect
	user.NewProc("SystemParametersInfoW").Call(0x30, 0, uintptr(unsafe.Pointer(&work)), 0)
	user.NewProc("GetWindowRect").Call(window, uintptr(unsafe.Pointer(&rect)))
	user.NewProc("SetWindowPos").Call(window, 0, uintptr(work.Left+(work.Right-work.Left-rect.Right+rect.Left)/2), uintptr(work.Top+(work.Bottom-work.Top-rect.Bottom+rect.Top)/2), 0, 0, 0x0015)
	return v
}
func (v *setupVisual) close() {
	for _, h := range []uintptr{v.background, v.font, v.heading} {
		if h != 0 {
			gdi.NewProc("DeleteObject").Call(h)
		}
	}
}
func (v *setupVisual) paint(window uintptr) {
	var p setupPaint
	dc, _, _ := user.NewProc("BeginPaint").Call(window, uintptr(unsafe.Pointer(&p)))
	if dc == 0 {
		return
	}
	defer user.NewProc("EndPaint").Call(window, uintptr(unsafe.Pointer(&p)))
	user.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&p.Rect)), v.background)
	var client setupRect
	user.NewProc("GetClientRect").Call(window, uintptr(unsafe.Pointer(&client)))
	if len(v.pixels) > 0 {
		size := v.scale(46)
		gdi.NewProc("SetStretchBltMode").Call(dc, 4)
		gdi.NewProc("StretchDIBits").Call(dc, uintptr((client.Right-size)/2), uintptr(v.scale(25)), uintptr(size), uintptr(size), 0, 0, uintptr(v.bitmap.Width), uintptr(-v.bitmap.Height), uintptr(unsafe.Pointer(&v.pixels[0])), uintptr(unsafe.Pointer(&v.bitmap)), 0, 0x00cc0020)
	}
}
