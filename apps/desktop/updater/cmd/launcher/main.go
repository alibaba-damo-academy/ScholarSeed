package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"scholarseed.local/desktop/updater/handoff"
)

// Replaced by a build overlay before branding, Authenticode signing and freeze.
var buildPolicy string

const loginCallbackScheme = "scholarseed"
const loginCallbackHost = "auth"
const loginCallbackPath = "/callback"

func main() { os.Exit(run()) }

func run() int {
	policy, err := handoff.ParseLauncherPolicy(buildPolicy)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if len(os.Args) == 2 && os.Args[1] == "--check-policy" {
		raw, _ := base64.StdEncoding.DecodeString(buildPolicy)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": handoff.Schema, "event": "policy", "policy_sha256": handoff.Hash(raw)})
		return 0
	}
	if err = policy.Activate(); err != nil {
		if interactive(os.Args[1:], os.Getenv("ELECTRON_RUN_AS_NODE")) {
			showFailure(policy.Messages, err)
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	self, err := os.Executable()
	if err != nil {
		if interactive(os.Args[1:], os.Getenv("ELECTRON_RUN_AS_NODE")) {
			showFailure(policy.Messages, err)
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	root := filepath.Dir(filepath.Dir(self))
	prepare := func(ctx context.Context, progress func(handoff.BootstrapProgress)) (handoff.BootstrapResult, error) {
		return policy.Policy.Bootstrap(ctx, root, policy.ComponentBaseURL, progress)
	}
	var result handoff.BootstrapResult
	showProgress := startupProgress(os.Args[1:], os.Getenv("ELECTRON_RUN_AS_NODE"))
	if showProgress {
		result, err = prepareWindow(policy.Messages, prepare)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), handoff.WorkerWait)
		result, err = prepare(ctx, nil)
		cancel()
	}
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			// A callback has no progress/retry window to display this failure.
			// Keep interactive errors visible without duplicating that window.
			if !showProgress && interactive(os.Args[1:], os.Getenv("ELECTRON_RUN_AS_NODE")) {
				showFailure(policy.Messages, err)
			}
			fmt.Fprintln(os.Stderr, err)
		}
		return 1
	}
	command := exec.Command(result.Executable, os.Args[1:]...)
	command.Dir = filepath.Dir(self)
	command.Env = engineEnvironment()
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err = command.Run(); err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return exited.ExitCode()
		}
		if interactive(os.Args[1:], os.Getenv("ELECTRON_RUN_AS_NODE")) {
			showFailure(policy.Messages, err)
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// Callback delivery reuses the running Desktop's login UI. Only presentation
// differs: Bootstrap, engine arguments, state validation and inbox delivery are
// unchanged. Incomplete callbacks also reach Electron's normal error handling.
func startupProgress(args []string, runAsNode string) bool {
	if !interactive(args, runAsNode) {
		return false
	}
	for _, arg := range args {
		if len(arg) >= 2 {
			first, last := arg[0], arg[len(arg)-1]
			if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
				arg = arg[1 : len(arg)-1]
			}
		}
		parsed, err := url.Parse(arg)
		if err == nil && strings.EqualFold(parsed.Scheme, loginCallbackScheme) &&
			strings.EqualFold(parsed.Hostname(), loginCallbackHost) && parsed.EscapedPath() == loginCallbackPath {
			return false
		}
	}
	return true
}

// Existing public noninteractive entry points retain their failure exit status;
// only their presentation differs. They execute the identical preparation policy.
func interactive(args []string, runAsNode string) bool {
	if runAsNode == "1" {
		return false
	}
	for _, arg := range args {
		name, _, _ := strings.Cut(arg, "=")
		switch name {
		case "--package-check", "--shoot", "--mode-check", "--say", "--drive", "--workbench-check":
			return false
		}
	}
	return true
}
