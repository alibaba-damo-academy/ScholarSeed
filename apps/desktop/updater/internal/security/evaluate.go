// Code generated from security.json; DO NOT EDIT. Schema=2 sha256=315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4
package security

const PolicyHash = "315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4"

type Entry struct {
	Principal    uint32 `json:"principal"`
	Mask         uint32 `json:"mask"`
	Flags        uint32 `json:"flags"`
	Deny         bool   `json:"deny"`
	Trusted      bool   `json:"trusted"`
	Universal    bool   `json:"universal"`
	AllowSubject bool   `json:"allow_subject"`
	DenySubject  bool   `json:"deny_subject"`
}
type Result struct {
	Reason int
	Index  int
	Mask   uint32
	Scope  int
}

const RoleContent = 0
const RoleAncestor = 1
const RoleVolume = 2
const RoleRuntime = 3

func Authority(principal, user string) bool {
	return principal != "" && (principal == user || principal == "S-1-5-18" || principal == "S-1-5-32-544" || principal == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
}

const SidSystem = "S-1-5-18"
const SidAdministrators = "S-1-5-32-544"
const SidTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
const SidOwnerRights = "S-1-3-4"
const SidEveryone = "S-1-1-0"
const SidAuthenticatedUsers = "S-1-5-11"
const DiagnosticSchema = 1
const DiagnosticEvent = "permission_rejected"

func DiagnosticProfile(value string) string {
	switch value {
	case "installation", "machine_authority", "tool_owner", "tool_writer", "recovery_owner", "recovery_writer", "private_owner", "private_writer", "lease_state", "lease_grant", "native_directory", "startup_mutex", "tool_access", "windows_api":
		return value
	}
	return "unknown"
}
func DiagnosticStage(value string) string {
	switch value {
	case "owner", "acl", "inspect", "binding", "grant", "lock", "setup", "recovery", "private":
		return value
	}
	return "unknown"
}
func DiagnosticReason(value string) string {
	switch value {
	case "policy_denied", "untrusted_owner", "foreign_writer", "execution_denied", "invalid_descriptor", "unsupported_ace", "os_access_denied", "os_error", "coordination_failed", "authorization_cancelled", "privilege_not_held":
		return value
	}
	return "unknown"
}

func MachineAuthority(principal string) bool {
	return principal != "" && (principal == SidSystem || principal == SidAdministrators)
}

func ToolOwner(principal string, user string, executor string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators) && principal != executor
}

func ToolWriter(principal string, user string, owner string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators || (principal == SidOwnerRights && owner != "" && (owner == user || owner == SidSystem || owner == SidAdministrators)))
}

func RecoveryOwner(principal string, user string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators)
}

func RecoveryWriter(principal string, user string, owner string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators || (principal == SidOwnerRights && owner != "" && (owner == user || owner == SidSystem || owner == SidAdministrators)))
}

func PrivateOwner(principal string, user string, administratorMember bool) bool {
	return principal != "" && (principal == user || (principal == SidAdministrators && administratorMember))
}

func PrivateWriter(principal string, user string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators)
}

func LeaseState(principal string, user string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators || principal == SidTrustedInstaller)
}

func LeaseGrant(principal string, user string) bool {
	return principal != "" && (principal == user || principal == SidSystem || principal == SidAdministrators)
}
func DiagnosticSubject(reason string) string {
	switch reason {
	case "untrusted_owner":
		return "owner"
	case "foreign_writer":
		return "writer"
	case "execution_denied":
		return "execution_token"
	}
	return "unknown"
}
func DiagnosticSystemReason(code uint32) string {
	switch code {
	case 5:
		return "os_access_denied"
	case 1223:
		return "authorization_cancelled"
	case 1300:
		return "privilege_not_held"
	case 1314:
		return "privilege_not_held"
	}
	return ""
}
func Owner(role int, trusted bool) bool {
	return (trusted || (role == 2))
}

func Mask(mask uint32) uint32 {
	if (mask & 2147483648) != 0 {
		mask = ((mask & (^uint32(2147483648))) | 1179785)
	}
	if (mask & 1073741824) != 0 {
		mask = ((mask & (^uint32(1073741824))) | 1179926)
	}
	if (mask & 536870912) != 0 {
		mask = ((mask & (^uint32(536870912))) | 1179808)
	}
	if (mask & 268435456) != 0 {
		mask = ((mask & (^uint32(268435456))) | 2032127)
	}
	return mask
}

func Allowed(role int) uint32 {
	var value uint32 = 1179817
	if (role == 1) || (role == 2) {
		value = (value | 6)
	}
	if role == 2 {
		value = (value | 852240)
	}
	return value
}

func Applies(flags uint32, role int, scope int) bool {
	if scope == 0 {
		return ((flags & 8) == 0)
	}
	if role != 3 {
		return false
	}
	if (scope >= 3) && ((flags & 4) != 0) {
		return false
	}
	if (scope == 1) || (scope == 3) {
		return ((flags & 1) != 0)
	}
	return ((flags & 2) != 0)
}

func Danger(entries []Entry, role int, index int, scope int) uint32 {
	if (entries[index].Deny || entries[index].Trusted) || (!Applies(entries[index].Flags, role, scope)) {
		return 0
	}
	var denied uint32 = 0
	for j := 0; j < index; j++ {
		if (entries[j].Deny && ((entries[j].Principal == entries[index].Principal) || entries[j].Universal)) && Applies(entries[j].Flags, role, scope) {
			denied = (denied | Mask(entries[j].Mask))
		}
	}
	return ((Mask(entries[index].Mask) & (^uint32(Allowed(role)))) & (^uint32(denied)))
}

func Blocked(entries []Entry, index int, scope int) uint32 {
	if !(entries[index].Deny && entries[index].DenySubject) {
		return 0
	}
	var granted uint32 = 0
	for j := 0; j < index; j++ {
		if ((!entries[j].Deny) && entries[j].AllowSubject) && Applies(entries[j].Flags, 3, scope) {
			granted = (granted | Mask(entries[j].Mask))
		}
	}
	return ((Mask(entries[index].Mask) & 1179817) & (^uint32(granted)))
}

func Evaluate(entries []Entry, role int, execution bool) Result {
	for i := 0; i < len(entries); i++ {
		for scope := 0; scope < 5; scope++ {
			var dangerous uint32 = Danger(entries, role, i, scope)
			if dangerous != 0 {
				return Result{1, i, dangerous, scope}
			}
			if execution && Applies(entries[i].Flags, role, scope) {
				var denied uint32 = Blocked(entries, i, scope)
				if denied != 0 {
					return Result{2, i, denied, scope}
				}
			}
		}
	}
	return Result{0, -1, 0, 0}
}
