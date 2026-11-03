package handoff

import "time"

const (
	iconRefreshStart          = "icon_refresh.start"
	iconRefreshFailed         = "icon_refresh.failed"
	iconRefreshNotified       = "icon_refresh.notified"
	applicationRestartStart   = "application_restart.start"
	applicationRestartFailed  = "application_restart.failed"
	applicationRestartStarted = "application_restart.started"
)

// The original-user coordinator calls this only after the updater has exited
// and the installed version has been checked. Velopack's after-update hook is
// too early: it runs before the updater rewrites application shortcuts.
func restartUpdatedApplication(executable string, args []string, refresh func(string) error, launch func(string, []string) (int, error), diagnostics *restartDiagnostics) error {
	started := time.Now()
	diagnostics.record(iconRefreshStart, started, 0, nil)
	if err := refresh(executable); err != nil {
		// Replacement has already finished. A presentation failure must not leave
		// the user without the updated application, but it must remain observable.
		diagnostics.record(iconRefreshFailed, started, 0, err)
	} else {
		// SHChangeNotify has no repaint acknowledgement.
		diagnostics.record(iconRefreshNotified, started, 0, nil)
	}
	started = time.Now()
	diagnostics.record(applicationRestartStart, started, 0, nil)
	pid, err := launch(executable, args)
	if err != nil {
		diagnostics.record(applicationRestartFailed, started, 0, err)
	} else {
		diagnostics.record(applicationRestartStarted, started, pid, nil)
	}
	return err
}
