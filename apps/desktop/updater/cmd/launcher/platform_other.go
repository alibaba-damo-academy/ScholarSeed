//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"scholarseed.local/desktop/updater/handoff"
)

func engineEnvironment() []string                                 { return os.Environ() }
func showFailure(_ map[string]handoff.StartupMessages, err error) { fmt.Fprintln(os.Stderr, err) }
func prepareWindow(map[string]handoff.StartupMessages, func(context.Context, func(handoff.BootstrapProgress)) (handoff.BootstrapResult, error)) (handoff.BootstrapResult, error) {
	return handoff.BootstrapResult{}, errors.New("launcher requires Windows")
}
