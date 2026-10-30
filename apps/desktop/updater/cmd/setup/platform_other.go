//go:build !windows

package main

import (
	"errors"
	"os"
)

func localized(m map[string]messages) messages { return m["en"] }
func showError(title, body string)             {}
func retryLegacy(string, string) bool          { return false }
func confirmDirectoryRisk(string, string) bool { return false }
func assessDirectory(string, string, configuration) ([]directoryRisk, error) {
	return nil, errors.New("Windows installer only")
}

type installationPins struct{}

func (*installationPins) replace(string, func() error) error {
	return errors.New("Windows installer only")
}

func pinInstallationParent(string) (*installationPins, error) {
	return nil, errors.New("Windows installer only")
}
func (*installationPins) prepare() error        { return errors.New("Windows installer only") }
func (*installationPins) close() error          { return nil }
func installedDirectory(string) (string, error) { return "", errors.New("Windows installer only") }
func defaultDirectory(string) (string, error)   { return "", errors.New("Windows installer only") }
func validateDirectory(string, string, configuration) error {
	return errors.New("Windows installer only")
}
func chooseDirectory(configuration, messages, string, string) (string, bool, error) {
	return "", false, errors.New("Windows installer only")
}

func holdPayload(path string) (*os.File, error) { return os.Open(path) }

func secureInstallation(string) error      { return errors.New("Windows installer only") }
func verifyInstalled(string, string) error { return errors.New("Windows installer only") }
func performInstallation(configuration, messages, string, func() error) error {
	return errors.New("Windows installer only")
}

type legacyInstallation struct{}

func discoverLegacy(*legacyPolicy, string) (*legacyInstallation, error) { return nil, nil }
func (*legacyInstallation) path() string                                { return "" }
func (*legacyInstallation) close()                                      {}
func (*legacyInstallation) verifySource() error                         { return errors.New("Windows installer only") }
func (*legacyInstallation) preflight(string) error                      { return errors.New("Windows installer only") }
func (*legacyInstallation) remove(string, string) error                 { return errors.New("Windows installer only") }
func (*legacyInstallation) unchanged() error                            { return errors.New("Windows installer only") }
func (*legacyInstallation) environment(base []string) []string          { return base }

func runLegacyWorker(configuration, []string) int { return 1 }

func prepareInstallationDirectory(string, string, configuration, directoryConsent) error {
	return errors.New("Windows installer only")
}

func registeredDirectory(string) (string, error) { return "", errors.New("Windows installer only") }
func inspectRemoval(string, string) (removalState, error) {
	return removalState{}, errors.New("Windows installer only")
}
