package main

import (
	"fmt"
	"os"
	"time"
)

const removalTimeout = 2 * time.Minute
const removalPoll = 250 * time.Millisecond

type removalState struct {
	active     bool
	complete   bool
	incomplete bool
	absent     bool
}

// Once partial removal has been observed, even an empty directory is not safe:
// Velopack schedules a delayed recursive deletion after its process exits.
func waitRemoval(root string, inspect func() (removalState, error), now func() time.Time, sleep func(time.Duration)) error {
	deadline := now().Add(removalTimeout)
	partial := false
	observedProcess := false
	for {
		state, err := inspect()
		if err != nil {
			return err
		}
		observedProcess = observedProcess || state.active
		partial = partial || state.incomplete || (observedProcess && !state.complete)
		if !state.active && (!partial || state.absent) {
			return nil
		}
		if !now().Before(deadline) {
			return &directoryIssue{Code: directoryUninstall, Path: root}
		}
		sleep(removalPoll)
	}
}

func awaitRemoval(c configuration, text messages, root string, silent bool) error {
	inspect := func() (removalState, error) { return inspectRemoval(root, c.AppID) }
	state, err := inspect()
	if err != nil {
		return err
	}
	if !state.active && !state.incomplete {
		return nil
	}
	// Preserve the first observation across progress-window creation.
	first := true
	operation := func() error {
		return waitRemoval(root, func() (removalState, error) {
			if first {
				first = false
				return state, nil
			}
			return inspect()
		}, time.Now, time.Sleep)
	}
	if silent {
		fmt.Fprintln(os.Stderr, text.UninstallWaiting)
		return operation()
	}
	text.Installing = text.Preparing
	text.Preparing = text.UninstallWaiting
	return performInstallation(c, text, root, operation)
}
