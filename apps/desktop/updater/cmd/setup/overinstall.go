package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const setupExitTimeout = 2 * time.Minute
const setupFrameBytes = 32
const setupExitPoll = 100 * time.Millisecond
const setupPipePrefix = `\\.\pipe\scholarseed-setup-`

var errSetupCancelled = errors.New("installation cancelled")
var errSetupBusy = errors.New("installation is still running")

func setupPipe(root string) string {
	digest := sha256.Sum256([]byte(strings.ToLower(strings.TrimRight(root, `\`))))
	return setupPipePrefix + hex.EncodeToString(digest[:])
}

func waitInstallationExit(inspect func() (bool, error), now func() time.Time, sleep func(time.Duration)) error {
	deadline := now().Add(setupExitTimeout)
	for {
		active, err := inspect()
		if err != nil {
			return err
		}
		if !active {
			return nil
		}
		if !now().Before(deadline) {
			return errSetupBusy
		}
		sleep(setupExitPoll)
	}
}

func prepareReplacement(root string, text messages, silent bool) error {
	active, err := installationActive(root)
	if err != nil || !active {
		return err
	}
	if silent {
		return errSetupBusy
	}
	supported, err := requestInstallationExit(root)
	if err != nil {
		return err
	}
	if !supported {
		// Historical clients have no cooperative endpoint. The user must quit them;
		// no global name-based termination or best-effort engine kill is permitted.
		if !confirmDirectoryRisk(text.Title, text.CloseRunning) {
			return errSetupCancelled
		}
	}
	return waitInstallationExit(func() (bool, error) { return installationActive(root) }, time.Now, time.Sleep)
}

// Only before official engine invocation may we restart the unchanged original.
// A started engine may already have replaced files, so it never uses this path.
func recoverReplacement(root, appID, original string) error {
	active, err := installationActive(root)
	if err != nil || active {
		return err
	}
	if err = verifyInstalled(root, appID); err != nil {
		return err
	}
	current, err := setupInstalledVersion(root, appID)
	if err != nil {
		return err
	}
	if original == "" || current != original {
		return errors.New("original installation changed before recovery")
	}
	command := exec.Command(filepath.Join(root, "Update.exe"), "--rootDir", root, "start")
	if err = command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
