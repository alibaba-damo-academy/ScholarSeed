package main

import (
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"

	"scholarseed.local/desktop/updater/handoff"
)

const setupIdentityLimit = 65536

var errReplacementDowngrade = errors.New("package downgrade rejected")

func setupInstalledVersion(root, appID string) (string, error) {
	file, err := os.Open(filepath.Join(root, "current", "sq.version"))
	if err != nil {
		return "", err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, setupIdentityLimit+1))
	if err != nil {
		return "", err
	}
	if len(raw) > setupIdentityLimit {
		return "", errors.New("installation identity exceeds limit")
	}
	var metadata struct {
		ID      string `xml:"metadata>id"`
		Version string `xml:"metadata>version"`
	}
	if err = xml.Unmarshal(raw, &metadata); err != nil {
		return "", err
	}
	if metadata.ID != appID {
		return "", errors.New("installation package identity differs")
	}
	return metadata.Version, nil
}

// Validate before requesting shutdown, and again before the official engine starts.
// A registered but empty root is a repair installation, not a known older version.
func validateReplacementVersion(root string, c configuration) error {
	current, err := setupInstalledVersion(root, c.AppID)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	comparison, err := handoff.ComparePackVersions(c.PackVersion, current)
	if err != nil {
		return err
	}
	if comparison < 0 {
		return errReplacementDowngrade
	}
	return nil
}

func validateReplacedVersion(root string, c configuration) error {
	current, err := setupInstalledVersion(root, c.AppID)
	if err != nil {
		return err
	}
	comparison, err := handoff.ComparePackVersions(c.PackVersion, current)
	if err != nil {
		return err
	}
	if comparison != 0 {
		return errors.New("installed version differs from the embedded installer")
	}
	return nil
}
