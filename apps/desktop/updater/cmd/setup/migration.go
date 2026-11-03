package main

import (
	"errors"
	"fmt"
	"strings"
)

var errLegacyCancelled = errors.New("legacy removal check cancelled")

// A failed qualification never authorizes a new installation. Retry performs
// discovery again, allowing a completed manual uninstall to become a fresh install.
func waitLegacy(check func() (*legacyInstallation, error), retry func(error) bool, silent bool) (*legacyInstallation, error) {
	for {
		legacy, err := check()
		if err == nil {
			return legacy, nil
		}
		if legacy != nil {
			legacy.close()
		}
		if silent {
			return nil, err
		}
		if !retry(err) {
			return nil, errLegacyCancelled
		}
	}
}

func awaitLegacy(c configuration, text messages, existing, destination string, silent bool) (*legacyInstallation, error) {
	return waitLegacy(func() (*legacyInstallation, error) {
		legacy, err := discoverLegacy(c.Legacy, existing)
		if err != nil {
			return nil, err
		}
		if legacy != nil && destination != "" {
			if err = legacy.verifySource(); err != nil {
				return legacy, &legacyIssue{Path: legacy.path(), Cause: err}
			}
			if err = legacy.preflight(destination); err != nil {
				return legacy, &legacyIssue{Path: legacy.path(), Cause: err}
			}
		}
		return legacy, nil
	}, func(err error) bool {
		return retryLegacy(text.Title, formatLegacyRemoval(text, err))
	}, silent)
}

type legacyIssue struct {
	Path  string
	Cause error
}

func (e *legacyIssue) Error() string {
	return fmt.Sprintf("legacy_removal_required path=%q: %v", e.Path, e.Cause)
}
func (e *legacyIssue) Unwrap() error { return e.Cause }

func formatLegacyRemoval(text messages, err error) string {
	path := text.LegacyUnknown
	cause := err
	var issue *legacyIssue
	if errors.As(err, &issue) {
		if issue.Path != "" {
			path = issue.Path
		}
		cause = issue.Cause
	}
	return strings.NewReplacer("{{path}}", path, "{{detail}}", directoryError(text, cause)).Replace(text.LegacyRemoval)
}
