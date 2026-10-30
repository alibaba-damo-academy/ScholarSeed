// Uninstall is a GUI entry point; the official updater owns all removal.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const updaterName = "Update.exe"

func updater(self string) (string, error) {
	directory := filepath.Dir(self)
	roots := []string{directory}
	if strings.EqualFold(filepath.Base(directory), "current") {
		roots = append(roots, filepath.Dir(directory))
	}
	var failures []error
	for _, root := range roots {
		var invalid error
		for _, name := range []string{filepath.Join(root, updaterName), filepath.Join(root, "current", "sq.version")} {
			st, err := os.Lstat(name)
			if err != nil {
				invalid = err
				break
			}
			if !st.Mode().IsRegular() {
				invalid = errors.New("invalid Velopack installation")
				break
			}
		}
		if invalid == nil {
			return filepath.Join(root, updaterName), nil
		}
		failures = append(failures, invalid)
	}
	return "", errors.Join(failures...)
}

func launch(self string, args []string) error {
	if len(args) > 1 || (len(args) == 1 && args[0] != "--silent") {
		return errors.New("only --silent is supported")
	}
	filename, err := updater(self)
	if err != nil {
		return err
	}
	command := exec.Command(filename, append([]string{"--uninstall"}, args...)...)
	command.Dir = filepath.Dir(filename)
	// Preserve the official updater's GUI startup state. HideWindow suppresses
	// its first progress window; --silent alone controls unattended removal.
	if err = command.Start(); err != nil {
		return err
	}
	// Never wait inside the installation: Velopack must be able to remove us.
	return command.Process.Release()
}

func main() {
	self, err := os.Executable()
	if err == nil {
		err = launch(self, os.Args[1:])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if len(os.Args) != 2 || os.Args[1] != "--silent" {
			showError(err)
		}
		os.Exit(1)
	}
}
