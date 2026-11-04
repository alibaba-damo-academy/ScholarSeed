package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"scholarseed.local/desktop/updater/handoff"
)

// Replaced through the Go overlay at build time; never loaded from a runtime
// request, environment variable or adjacent mutable configuration file.
var buildPolicy string

const maximumProcessID = 1<<32 - 1

func main() {
	request := flag.String("request", "", "bounded coordinator request")
	worker := flag.String("worker", "", "restricted worker request")
	status := flag.String("status", "", "worker status file")
	control := flag.String("control", "", "worker commit file")
	nonce := flag.String("nonce", "", "worker channel nonce")
	parent := flag.Uint("parent", 0, "coordinator process")
	check := flag.Bool("check-policy", false, "print compiled policy identity")
	sandboxHome := flag.String("sandbox-home", "", "bounded sandbox home preparation")
	sandboxVersion := flag.String("sandbox-version", "", "reviewed native runtime version")
	sandboxRuntime := flag.String("sandbox-runtime", "", "installed native executable")
	sandboxParent := flag.Uint("sandbox-parent", 0, "original sandbox coordinator")
	sandboxSnapshot := flag.String("sandbox-snapshot", "", "sandbox security snapshot")
	flag.Parse()
	sandboxRequested := *sandboxHome != "" || *sandboxVersion != "" || *sandboxRuntime != "" || *sandboxParent != 0 || *sandboxSnapshot != ""
	p, err := handoff.ParsePolicy(buildPolicy)
	if err == nil && *request != "" && *worker == "" {
		err = p.ValidateRecoveryMessages()
	}
	if err == nil && *check && !sandboxRequested {
		raw, _ := base64.StdEncoding.DecodeString(buildPolicy)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": handoff.Schema, "event": "policy", "policy_sha256": handoff.Hash(raw)})
		return
	}
	if err == nil && runtime.GOOS != "windows" {
		err = fmt.Errorf("handoff execution requires Windows")
	}
	if err == nil {
		if *sandboxHome != "" {
			if *request != "" || *worker != "" || *status != "" || *control != "" || *nonce != "" || *parent != 0 || *check || flag.NArg() != 0 || *sandboxParent > maximumProcessID || (*sandboxParent == 0) != (*sandboxSnapshot == "") {
				err = handoff.SandboxArgumentFailure(fmt.Errorf("sandbox recovery cannot contain update inputs"))
			} else {
				var result handoff.SandboxResult
				result, err = p.RecoverSandbox(*sandboxHome, *sandboxVersion, *sandboxRuntime, uint32(*sandboxParent), *sandboxSnapshot)
				if err == nil {
					_ = json.NewEncoder(os.Stdout).Encode(result)
				}
			}
		} else if *sandboxVersion != "" || *sandboxRuntime != "" || *sandboxParent != 0 || *sandboxSnapshot != "" {
			err = handoff.SandboxArgumentFailure(fmt.Errorf("sandbox recovery requires a home"))
		} else if *request != "" && *worker == "" {
			err = p.Coordinate(*request)
		} else if *worker != "" && *request == "" {
			err = p.Worker(*worker, *status, *control, *nonce, uint32(*parent))
		} else {
			err = fmt.Errorf("exactly one operation is required")
		}
	}
	if err != nil {
		if sandboxRequested {
			_ = json.NewEncoder(os.Stdout).Encode(handoff.SandboxDiagnostic(err))
			os.Exit(handoff.SandboxExitCode(err))
		}
		_ = json.NewEncoder(os.Stdout).Encode(handoff.Event{Event: "error", Message: err.Error()})
		if failure := recoveryFailure(*request, *worker, err); failure != nil {
			if presentationErr := showRecovery(p.RecoveryMessages, failure); presentationErr != nil {
				fmt.Fprintln(os.Stderr, presentationErr)
			}
		}
		os.Exit(1)
	}
}

func recoveryFailure(request, worker string, failure error) *handoff.UpdateRecoveryError {
	if request == "" || worker != "" {
		return nil
	}
	var recovery *handoff.UpdateRecoveryError
	if errors.As(failure, &recovery) {
		return recovery
	}
	return nil
}
