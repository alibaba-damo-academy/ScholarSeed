//go:build !windows

package main

import (
	"errors"

	"scholarseed.local/desktop/updater/handoff"
)

func showRecovery(map[string]handoff.RecoveryMessages, *handoff.UpdateRecoveryError) error {
	return errors.New("native update recovery dialog requires Windows")
}
