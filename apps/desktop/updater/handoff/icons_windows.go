package handoff

import (
	"runtime"
	"syscall"
	"unsafe"
)

const (
	shellUpdateItem          = 0x00002000
	shellAssociationsChanged = 0x08000000
	shellPathUnicode         = 0x0005
	shellFlush               = 0x1000
)

func refreshApplicationIcons(executable string) error {
	if err := checkLineage(executable); err != nil {
		return err
	}
	path, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return err
	}
	notify := shell.NewProc("SHChangeNotify")
	if err = notify.Find(); err != nil {
		return err
	}
	// The icon bytes changed while the executable path and AppUserModelID stayed
	// stable. Invalidate the Shell's cached shortcut/group icon before the next
	// application window establishes its taskbar group. FLUSH waits for delivery;
	// SHChangeNotify returns void, not an icon-repaint success acknowledgement.
	notify.Call(shellUpdateItem, shellPathUnicode|shellFlush, uintptr(unsafe.Pointer(path)), 0)
	runtime.KeepAlive(path)
	notify.Call(shellAssociationsChanged, shellFlush, 0, 0)
	return nil
}
