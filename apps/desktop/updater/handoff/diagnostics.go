package handoff

import (
	"encoding/json"
	"errors"
	"io"
	"slices"
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
	sandboxStageMetadata      = "metadata"
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
	sandboxLogLimit           = 90
)

const (
	sandboxRuleDescriptor    = "invalid_descriptor"
	sandboxRuleACL           = "invalid_acl"
	sandboxRuleACE           = "unsupported_ace"
	sandboxRuleDeny          = "deny_ace"
	sandboxRuleOwnerRights   = "owner_rights_mask"
	sandboxRulePrincipal     = "unknown_principal"
	sandboxRuleGroupMask     = "native_group_mask"
	sandboxRuleOwner         = "untrusted_owner"
	sandboxRuleMaintenance   = "maintenance_owner"
	sandboxRuleACLBound      = "acl_limit"
	sandboxRuleDrift         = "security_drift"
	sandboxRulePostcondition = "postcondition_drift"
	sandboxRuleReparse       = "reparse_point"
	sandboxRuleType          = "object_type"
	sandboxRuleHardlink      = "hardlink"
	sandboxRuleLogBound      = "daily_log_limit"
	sandboxRuleNativeDeny    = "native_deny"
	sandboxRuleMask          = "permission_mask"
	sandboxRulePrivate       = "private_policy"
	sandboxRuleUnknown       = "unknown"
	sandboxObjectProfile     = "profile"
	sandboxObjectProduct     = "product"
	sandboxObjectHome        = "codex"
	sandboxObjectBin         = "sandbox_bin"
	sandboxObjectMetadata    = "metadata"
	sandboxObjectLog         = "daily_log"
)

var sandboxDiagnosticRules = []string{
	sandboxRuleDescriptor, sandboxRuleACL, sandboxRuleACE, sandboxRuleDeny,
	sandboxRuleOwnerRights, sandboxRulePrincipal, sandboxRuleGroupMask, sandboxRuleOwner,
	sandboxRuleMaintenance, sandboxRuleACLBound, sandboxRuleDrift, sandboxRulePostcondition,
	sandboxRuleReparse, sandboxRuleType, sandboxRuleHardlink, sandboxRuleLogBound,
	sandboxRuleNativeDeny, sandboxRuleMask, sandboxRulePrivate, sandboxRuleUnknown,
}

var sandboxDiagnosticObjects = []string{
	sandboxObjectProfile, sandboxObjectProduct, sandboxObjectHome,
	sandboxObjectBin, sandboxObjectMetadata, sandboxObjectLog,
}

type sandboxCheckError struct {
	cause  error
	rule   string
	object string
	count  int
}

func (failure *sandboxCheckError) Error() string { return "sandbox metadata check failed" }
func (failure *sandboxCheckError) Unwrap() error { return failure.cause }

func sandboxCheckFailure(rule string, cause error) error {
	return &sandboxCheckError{cause: cause, rule: rule}
}

func sandboxMetadataFailure(object string, cause error) error {
	if cause == nil {
		return nil
	}
	var previous *sandboxCheckError
	if errors.As(cause, &previous) {
		if previous.object != "" {
			return cause
		}
		return &sandboxCheckError{cause: cause, rule: previous.rule, object: object, count: previous.count}
	}
	return &sandboxCheckError{cause: cause, rule: sandboxRuleUnknown, object: object}
}

var sandboxDiagnosticStages = [...]string{
	sandboxStagePolicy, sandboxStageArguments, sandboxStageVersion, sandboxStageCoordinator,
	sandboxStageInstallation, sandboxStageRuntime, sandboxStageIdentity, sandboxStageLocation,
	sandboxStageProfile, sandboxStageProduct, sandboxStageHome, sandboxStageTarget,
	sandboxStageOwner, sandboxStageElevation, sandboxStageWorker, sandboxStagePrivilege,
	sandboxStageVerification, sandboxStageMetadata,
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
	Object      string `json:"object,omitempty"`
	Rule        string `json:"rule,omitempty"`
	Count       int    `json:"count,omitempty"`
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
	var check *sandboxCheckError
	if stage == sandboxStageMetadata && errors.As(cause, &check) {
		if slices.Contains(sandboxDiagnosticObjects, check.object) {
			diagnostic.Object = check.object
			diagnostic.Rule = sandboxRuleUnknown
			if slices.Contains(sandboxDiagnosticRules, check.rule) {
				diagnostic.Rule = check.rule
			}
			if diagnostic.Rule == sandboxRuleLogBound && check.count == sandboxLogLimit+1 {
				diagnostic.Count = check.count
			}
		}
	}
	return &sandboxDiagnosticError{diagnostic}
}

func SandboxDiagnostic(cause error) sandboxDiagnostic {
	return sandboxFailure(sandboxStagePolicy, cause).(*sandboxDiagnosticError).diagnostic
}

func WriteSandboxDiagnostic(stdout, stderr io.Writer, cause error) {
	diagnostic := SandboxDiagnostic(cause)
	if diagnostic.Object != "" {
		_ = json.NewEncoder(stderr).Encode(diagnostic)
	}
	diagnostic.Object, diagnostic.Rule, diagnostic.Count = "", "", 0
	_ = json.NewEncoder(stdout).Encode(diagnostic)
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
