package handoff

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

const Uninstaller = "Uninstall.exe"

// Install and update hooks publish the already-signed entry point at the stable
// installation root. No runtime or network access is needed by these fast hooks.
func publishUninstaller() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return publishUninstallerIn(filepath.Dir(self))
}

func publishUninstallerIn(current string) error {
	if filepath.Base(current) != "current" {
		return errors.New("uninstaller publication requires installed current")
	}
	parents, err := pinLineage(current)
	if err != nil {
		return err
	}
	defer closeFiles(parents)
	source, err := pinFile(filepath.Join(current, Uninstaller))
	if err != nil {
		return err
	}
	defer source.Close()
	root := filepath.Dir(current)
	target, err := os.CreateTemp(root, ".uninstall-*.exe")
	if err != nil {
		return err
	}
	defer os.Remove(target.Name())
	_, copyErr := io.Copy(target, source)
	closeErr := target.Close()
	if err = errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	return os.Rename(target.Name(), filepath.Join(root, Uninstaller))
}
