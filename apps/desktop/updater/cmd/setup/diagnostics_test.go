package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFormatDirectoryIssue(t *testing.T) {
	templates := messages{
		UninstallIncomplete: "uninstall", InvalidPath: "invalid", TooLong: "long", InvalidName: "name",
		Relocation: "relocation", Reparse: "reparse", Protected: "protected",
		Drive: "drive", NotEmpty: "not empty", NotWritable: "not writable",
		Permission: "permission", Inspection: "inspection", RiskChanged: "changed", Launch: "launch",
	}
	cases := []struct {
		code directoryIssueCode
		want string
	}{
		{directoryUninstall, "uninstall"}, {directoryInvalidPath, "invalid"}, {directoryTooLong, "long"},
		{directoryInvalidName, "name"}, {directoryRelocation, "relocation"},
		{directoryReparse, "reparse"}, {directoryProtected, "protected"},
		{directoryDrive, "drive"}, {directoryNotEmpty, "not empty"},
		{directoryNotWritable, "not writable"}, {directoryPermission, "permission"},
		{directoryInspection, "inspection"}, {directoryRiskChanged, "changed"},
		{directoryLaunch, "launch"}, {directoryIssueCode("future"), "inspection"},
	}
	for _, scenario := range cases {
		t.Run(string(scenario.code), func(t *testing.T) {
			issue := &directoryIssue{Code: scenario.code, Path: `D:\书深 Apps`}
			if got := formatDirectoryIssue(templates, issue); got != scenario.want {
				t.Fatalf("got %q, want %q", got, scenario.want)
			}
			issue.Cause = errors.New("system detail")
			if got := formatDirectoryIssue(templates, issue); got != scenario.want+"\nsystem detail" {
				t.Fatalf("diagnostic lost: %q", got)
			}
		})
	}
}

func TestDirectoryIssueInterpolation(t *testing.T) {
	text := messages{Inspection: "inspect {{path}}: {{detail}}; {{path}}"}
	issue := &directoryIssue{Code: directoryInspection, Path: `D:\{{detail}}\书深`, Cause: errors.New("raw {{path}}\r\nerror")}
	want := "inspect " + issue.Path + ": " + issue.Cause.Error() + "; " + issue.Path
	if got := formatDirectoryIssue(text, issue); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	issue.Cause = nil
	if got := formatDirectoryIssue(text, issue); got != "inspect "+issue.Path+": ; "+issue.Path {
		t.Fatalf("nil cause: %q", got)
	}
	if got := formatDirectoryIssue(text, nil); got != "" {
		t.Fatalf("nil issue: %q", got)
	}
}

func TestDirectoryIssueErrorChain(t *testing.T) {
	cause := errors.New("access denied")
	issue := &directoryIssue{Code: directoryPermission, Path: `D:\安装`, Principal: "S-1-5-21", Mask: 0x40000, Cause: cause}
	var failure error = issue
	for _, detail := range []string{string(issue.Code), issue.Path, issue.Principal, "0x00040000", cause.Error()} {
		if !strings.Contains(failure.Error(), detail) {
			t.Fatalf("missing %q in %q", detail, failure.Error())
		}
	}
	wrapped := fmt.Errorf("setup: %w", failure)
	var found *directoryIssue
	if !errors.Is(wrapped, cause) || !errors.As(wrapped, &found) || found != issue {
		t.Fatal("directory error chain not preserved")
	}
	issue.Cause = nil
	if issue.Unwrap() != nil || !strings.Contains(issue.Error(), issue.Path) {
		t.Fatal("cause-free issue lost its path")
	}
	var absent *directoryIssue
	if absent.Error() != "" || absent.Unwrap() != nil {
		t.Fatal("nil issue not handled")
	}
}

func TestRelocationMessageExplainsBothLocations(t *testing.T) {
	for _, language := range []string{"zh", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "localization", "locales", language, "native.json"))
		if err != nil {
			t.Fatal(err)
		}
		var resource struct {
			Installer messages `json:"installer"`
		}
		if err := json.Unmarshal(raw, &resource); err != nil {
			t.Fatal(err)
		}
		issue := &directoryIssue{Code: directoryRelocation, Path: `D:\new`, RegisteredPath: `C:\existing`}
		got := directoryError(resource.Installer, issue)
		for _, required := range []string{issue.Path, issue.RegisteredPath} {
			if !strings.Contains(got, required) {
				t.Fatalf("%s missing location %q: %s", language, required, got)
			}
		}
		if strings.Contains(got, "{{") || strings.Contains(got, "reinstallation must") {
			t.Fatalf("%s untranslated relocation: %s", language, got)
		}
	}
}

func TestFormatDirectoryRisks(t *testing.T) {
	text := messages{Risk: "risk {{path}}", RiskEntry: "{{path}} | {{principal}} | {{mask}} | {{reason}}", RiskOwner: "localized owner", RiskAccess: "localized access"}
	risks := []directoryRisk{
		{Path: `D:\祖先`, Principal: "S-1-5-21", Mask: 0x40000, Reason: directoryRiskOwner},
		{Path: `D:\{{principal}}`, Principal: "Users {{reason}}", Mask: ^uint32(0), Reason: directoryRiskAccess},
		{Path: `D:\unknown`, Mask: 0, Reason: "future reason"},
	}
	want := "risk D:\\书深\n\nD:\\祖先 | S-1-5-21 | 0x00040000 | localized owner\n\nD:\\{{principal}} | Users {{reason}} | 0xffffffff | localized access\n\nD:\\unknown |  | 0x00000000 | future reason"
	if got := formatDirectoryRisks(text, `D:\书深`, risks); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	identities := map[directoryRisk]bool{risks[0]: true}
	if !identities[risks[0]] || identities[risks[1]] || risks[0].Reason != directoryRiskOwner {
		t.Fatal("risk identities changed")
	}
	for _, empty := range [][]directoryRisk{nil, {}} {
		if got := formatDirectoryRisks(text, "root", empty); got != "" {
			t.Fatalf("empty risks: %q", got)
		}
	}
}

func TestDirectoryDiagnosticsResources(t *testing.T) {
	for _, language := range []string{"en", "zh"} {
		t.Run(language, func(t *testing.T) {
			filename := filepath.Join("..", "..", "..", "src", "localization", "locales", language, "native.json")
			raw, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			var resource struct {
				Installer messages `json:"installer"`
			}
			if err := json.Unmarshal(raw, &resource); err != nil {
				t.Fatal(err)
			}
			for _, code := range []directoryIssueCode{directoryInvalidPath, directoryTooLong, directoryInvalidName, directoryRelocation, directoryReparse, directoryProtected, directoryDrive, directoryNotEmpty, directoryNotWritable, directoryPermission, directoryInspection, directoryRiskChanged, directoryLaunch, "unknown"} {
				issue := &directoryIssue{Code: code, Path: `D:\书深 Apps`, Cause: errors.New("native detail")}
				got := formatDirectoryIssue(resource.Installer, issue)
				if !strings.Contains(got, issue.Path) || !strings.Contains(got, issue.Cause.Error()) || strings.Contains(got, "{{") {
					t.Fatalf("%s: %q", code, got)
				}
			}
			for _, reason := range []string{directoryRiskOwner, directoryRiskAccess} {
				got := formatDirectoryRisks(resource.Installer, `D:\书深`, []directoryRisk{{Path: `D:\`, Principal: "S-1-5-32-545", Mask: 1, Reason: reason}})
				if strings.Contains(got, "{{") || !strings.Contains(got, "S-1-5-32-545") || !strings.Contains(got, "0x00000001") {
					t.Fatalf("%s: %q", reason, got)
				}
			}
		})
	}
}

func TestUninstallMessages(t *testing.T) {
	for _, language := range []string{"zh", "en"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "localization", "locales", language, "native.json"))
		if err != nil {
			t.Fatal(err)
		}
		var resource struct{ Installer messages }
		if err = json.Unmarshal(raw, &resource); err != nil {
			t.Fatal(err)
		}
		text := resource.Installer
		if text.UninstallWaiting == "" || !strings.Contains(text.UninstallIncomplete, "{{path}}") {
			t.Fatalf("missing uninstall guidance for %s", language)
		}
		got := directoryError(text, &directoryIssue{Code: directoryUninstall, Path: `D:\tt`})
		if !strings.Contains(got, `D:\tt`) || strings.Contains(got, "{{path}}") {
			t.Fatal(got)
		}
	}
}
