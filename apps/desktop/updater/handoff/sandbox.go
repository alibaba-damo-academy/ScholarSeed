package handoff

import (
	"errors"
	aclpolicy "scholarseed.local/desktop/updater/internal/security"
	"strings"
)

const (
	sandboxVersion        = "0.165.0"
	sandboxPriorVersion   = "0.163.0"
	sandboxSecrets        = ".sandbox-secrets"
	sandboxProduct        = ".scholarseed"
	sandboxHomeName       = "codex"
	sandboxUnchanged      = "unchanged"
	sandboxPrepared       = "prepared"
	sandboxRepaired       = "repaired"
	sandboxUnsupported    = "unsupported"
	sandboxRepairRequired = "repair_required"
	sandboxParentFlag     = "--sandbox-parent"
	sandboxHomeFlag       = "--sandbox-home"
	sandboxVersionFlag    = "--sandbox-version"
	sandboxRuntimeFlag    = "--sandbox-runtime"
	sandboxSnapshotFlag   = "--sandbox-snapshot"
	sandboxAdminSID       = aclpolicy.SidAdministrators
	sandboxTraverseMask   = 0x00100020
	sandboxTraverseFlags  = 0x10
)

type SandboxResult struct {
	Event string `json:"event"`
}

func sandboxAncestorTraversal(mask uint32, flags byte) bool {
	return mask&^uint32(sandboxTraverseMask) == 0 && flags&^byte(sandboxTraverseFlags) == 0
}

func validateSandboxVersion(version string) error {
	if version != sandboxVersion && version != sandboxPriorVersion {
		return errors.New("sandbox recovery runtime version is not reviewed")
	}
	return nil
}

func sandboxRuntimeVersionMatches(version, componentVersion string) bool {
	return validateSandboxVersion(version) == nil && componentVersionPattern.MatchString(componentVersion) && strings.HasPrefix(componentVersion, version+"-r")
}

func sandboxPreparationEvent(owner, user string, writable bool) string {
	if owner == sandboxAdminSID {
		return sandboxRepairRequired
	}
	if owner == user && writable {
		return sandboxUnchanged
	}
	return sandboxUnsupported
}
