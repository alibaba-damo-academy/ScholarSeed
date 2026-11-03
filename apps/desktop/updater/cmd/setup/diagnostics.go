package main

import (
	"fmt"
	"strings"
)

type directoryIssueCode string

const (
	directoryUninstall   directoryIssueCode = "uninstall_incomplete"
	directoryInvalidPath directoryIssueCode = "invalid_path"
	directoryTooLong     directoryIssueCode = "too_long"
	directoryInvalidName directoryIssueCode = "invalid_name"
	directoryRelocation  directoryIssueCode = "relocation"
	directoryReparse     directoryIssueCode = "reparse"
	directoryProtected   directoryIssueCode = "protected"
	directoryDrive       directoryIssueCode = "drive"
	directoryNotEmpty    directoryIssueCode = "not_empty"
	directoryNotWritable directoryIssueCode = "not_writable"
	directoryPermission  directoryIssueCode = "permission"
	directoryInspection  directoryIssueCode = "inspection"
	directoryRiskChanged directoryIssueCode = "risk_changed"
	directoryLaunch      directoryIssueCode = "launch"
	directoryRiskOwner                      = "owner"
	directoryRiskAccess                     = "access"
)

type directoryIssue struct {
	Code           directoryIssueCode
	Path           string
	RegisteredPath string
	Principal      string
	Mask           uint32
	Cause          error
}

func (issue *directoryIssue) Error() string {
	if issue == nil {
		return ""
	}
	detail := fmt.Sprintf("directory %s: %s", issue.Code, issue.Path)
	if issue.RegisteredPath != "" {
		detail += fmt.Sprintf(" (registered=%s)", issue.RegisteredPath)
	}
	if issue.Principal != "" || issue.Mask != 0 {
		detail += fmt.Sprintf(" (principal=%s, mask=0x%08x)", issue.Principal, issue.Mask)
	}
	if issue.Cause != nil {
		detail += ": " + issue.Cause.Error()
	}
	return detail
}

func (issue *directoryIssue) Unwrap() error {
	if issue == nil {
		return nil
	}
	return issue.Cause
}

type directoryRisk struct {
	Path      string
	Principal string
	Mask      uint32
	Reason    string
}

func formatDirectoryIssue(text messages, issue *directoryIssue) string {
	if issue == nil {
		return ""
	}
	template := text.Inspection
	switch issue.Code {
	case directoryUninstall:
		template = text.UninstallIncomplete
	case directoryInvalidPath:
		template = text.InvalidPath
	case directoryTooLong:
		template = text.TooLong
	case directoryInvalidName:
		template = text.InvalidName
	case directoryRelocation:
		template = text.Relocation
	case directoryReparse:
		template = text.Reparse
	case directoryProtected:
		template = text.Protected
	case directoryDrive:
		template = text.Drive
	case directoryNotEmpty:
		template = text.NotEmpty
	case directoryNotWritable:
		template = text.NotWritable
	case directoryPermission:
		template = text.Permission
	case directoryRiskChanged:
		template = text.RiskChanged
	case directoryLaunch:
		template = text.Launch
	}
	detail := ""
	if issue.Cause != nil {
		detail = issue.Cause.Error()
	}
	result := strings.NewReplacer("{{path}}", issue.Path, "{{registeredPath}}", issue.RegisteredPath, "{{detail}}", detail).Replace(template)
	if detail != "" && !strings.Contains(template, "{{detail}}") {
		result += "\n" + detail
	}
	return result
}

func formatDirectoryRisks(text messages, root string, risks []directoryRisk) string {
	if len(risks) == 0 {
		return ""
	}
	lines := []string{strings.ReplaceAll(text.Risk, "{{path}}", root)}
	for _, risk := range risks {
		reason := risk.Reason
		switch reason {
		case directoryRiskOwner:
			reason = text.RiskOwner
		case directoryRiskAccess:
			reason = text.RiskAccess
		}
		lines = append(lines, strings.NewReplacer(
			"{{path}}", risk.Path,
			"{{principal}}", risk.Principal,
			"{{mask}}", fmt.Sprintf("0x%08x", risk.Mask),
			"{{reason}}", reason,
		).Replace(text.RiskEntry))
	}
	return strings.Join(lines, "\n\n")
}
