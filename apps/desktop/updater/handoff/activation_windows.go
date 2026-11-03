package handoff

import (
	"fmt"
	"os"
	"syscall"
)

func activateVelopack(filename string) error {
	library, err := syscall.LoadDLL(filename)
	if err != nil {
		return err
	}
	defer library.Release()
	auto, err := library.FindProc("vpkc_app_set_auto_apply_on_startup")
	if err != nil {
		return err
	}
	run, err := library.FindProc("vpkc_app_run")
	if err != nil {
		return err
	}
	for _, hook := range []struct {
		name   string
		action func() error
	}{
		{"vpkc_app_set_hook_after_install", publishUninstaller},
		{"vpkc_app_set_hook_after_update", maintainAfterUpdate},
		{"vpkc_app_set_hook_before_uninstall", cleanBeforeUninstall},
	} {
		setter, err := library.FindProc(hook.name)
		if err != nil {
			return err
		}
		action := hook.action
		callback := syscall.NewCallback(func(_, _ uintptr) uintptr {
			if err := action(); err != nil {
				fmt.Fprintln(os.Stderr, "Velopack lifecycle:", err)
			}
			return 0
		})
		_, _, _ = setter.Call(callback)
	}
	_, _, _ = auto.Call(0)
	_, _, _ = run.Call(0) // Both official C functions return void.
	return nil
}
