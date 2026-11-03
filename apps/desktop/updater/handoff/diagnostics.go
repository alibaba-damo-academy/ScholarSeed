package handoff

import (
	"errors"
	"syscall"
)

const (
	sandboxFailed             = "failed"
	sandboxStagePolicy        = "policy"
	sandboxStageArguments     = "arguments"
	sandboxStageVersion       = "version"
	sandboxStageCoordinator   = "coordinator"
	sandboxStageInstallation  = "installation"
	sandboxStageRuntime       = "runtime"
	sandboxStageIdentity      = "identity"
	sandboxStageLocation      = "location"
	sandboxStageProfile       = "ancestor_profile"
	sandboxStageProduct       = "ancestor_product"
	sandboxStageHome          = "ancestor_codex"
	sandboxStageTarget        = "target"
	sandboxStageOwner         = "owner"
	sandboxStageElevation     = "elevation"
	sandboxStageWorker        = "worker"
	sandboxStagePrivilege     = "worker_privilege"
	sandboxStageVerification  = "verification"
	sandboxReasonPolicy       = "policy_rejected"
	sandboxReasonAccess       = "access_denied"
	sandboxReasonPrivilege    = "privilege_missing"
	sandboxReasonCancelled    = "cancelled"
	sandboxReasonSystem       = "system_error"
	sandboxReasonWorker       = "worker_failed"
	sandboxAccessDenied       = syscall.Errno(5)
	sandboxNotAssigned        = syscall.Errno(1300)
	sandboxPrivilegeDenied    = syscall.Errno(1314)
	sandboxDiagnosticExitBase = 4000
)

var sandboxDiagnosticStages = [...]string{
	sandboxStagePolicy, sandboxStageArguments, sandboxStageVersion, sandboxStageCoordinator,
	sandboxStageInstallation, sandboxStageRuntime, sandboxStageIdentity, sandboxStageLocation,
	sandboxStageProfile, sandboxStageProduct, sandboxStageHome, sandboxStageTarget,
	sandboxStageOwner, sandboxStageElevation, sandboxStageWorker, sandboxStagePrivilege,
	sandboxStageVerification,
}

var sandboxDiagnosticReasons = [...]string{
	sandboxReasonPolicy, sandboxReasonAccess, sandboxReasonPrivilege, sandboxReasonCancelled,
	sandboxReasonSystem, sandboxReasonWorker,
}

type sandboxDiagnostic struct {
	Event       string `json:"event"`
	Stage       string `json:"stage"`
	Reason      string `json:"reason"`
	SystemError uint32 `json:"system_error,omitempty"`
}

type sandboxDiagnosticError struct {
	diagnostic sandboxDiagnostic
}

func (failure *sandboxDiagnosticError) Error() string {
	return "sandbox recovery failed: " + failure.diagnostic.Stage + "/" + failure.diagnostic.Reason
}

func sandboxFailure(stage string, cause error) error {
	var existing *sandboxDiagnosticError
	if errors.As(cause, &existing) {
		return existing
	}
	diagnostic := sandboxDiagnostic{Event: sandboxFailed, Stage: stage, Reason: sandboxReasonPolicy}
	var systemError syscall.Errno
	if errors.Is(cause, ErrCancelled) {
		diagnostic.Reason = sandboxReasonCancelled
	} else if errors.As(cause, &systemError) {
		diagnostic.SystemError = uint32(systemError)
		switch systemError {
		case sandboxAccessDenied:
			diagnostic.Reason = sandboxReasonAccess
		case sandboxNotAssigned, sandboxPrivilegeDenied:
			diagnostic.Reason = sandboxReasonPrivilege
		default:
			diagnostic.Reason = sandboxReasonSystem
		}
	}
	return &sandboxDiagnosticError{diagnostic}
}

func SandboxDiagnostic(cause error) sandboxDiagnostic {
	return sandboxFailure(sandboxStagePolicy, cause).(*sandboxDiagnosticError).diagnostic
}

func SandboxExitCode(cause error) int {
	diagnostic := SandboxDiagnostic(cause)
	for stage, value := range sandboxDiagnosticStages {
		if value != diagnostic.Stage {
			continue
		}
		for reason, value := range sandboxDiagnosticReasons {
			if value == diagnostic.Reason {
				return sandboxDiagnosticExitBase + stage*len(sandboxDiagnosticReasons) + reason
			}
		}
	}
	return 1
}

func sandboxWorkerFailure(code uint32) error {
	offset := int64(code) - sandboxDiagnosticExitBase
	if offset >= 0 && offset < int64(len(sandboxDiagnosticStages)*len(sandboxDiagnosticReasons)) {
		return &sandboxDiagnosticError{sandboxDiagnostic{
			Event:  sandboxFailed,
			Stage:  sandboxDiagnosticStages[offset/int64(len(sandboxDiagnosticReasons))],
			Reason: sandboxDiagnosticReasons[offset%int64(len(sandboxDiagnosticReasons))],
		}}
	}
	return &sandboxDiagnosticError{sandboxDiagnostic{Event: sandboxFailed, Stage: sandboxStageWorker, Reason: sandboxReasonWorker}}
}

func SandboxArgumentFailure(cause error) error {
	return sandboxFailure(sandboxStageArguments, cause)
}
