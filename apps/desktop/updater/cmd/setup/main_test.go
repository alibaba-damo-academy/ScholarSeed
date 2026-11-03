package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestCaptureDirectoryConsentCopiesRisks(t *testing.T) {
	risks := []directoryRisk{{Path: "parent", Principal: "writer", Mask: permissionDelete}}
	consent := captureDirectoryConsent(risks)
	if !reflect.DeepEqual(consent.Risks, risks) {
		t.Fatalf("%+v", consent)
	}
	risks[0].Mask = 0
	if consent.Risks[0].Mask != permissionDelete {
		t.Fatal("consent aliases input")
	}
}

func TestInstallerArguments(t *testing.T) {
	o, err := parseOptions([]string{"--silent", "--installto", `D:\书深 Apps\ScholarSeed`, "--log", `D:\log file.txt`, "--", "--say", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--installto", `D:\书深 Apps\ScholarSeed`, "--silent", "--log", `D:\log file.txt`, "--", "--say", "hello"}
	if got := installerArguments(o, o.Directory); !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	for _, args := range [][]string{{"--installto"}, {"--installto", ""}, {"--installto", "a", "--installto=b"}, {"--unknown"}, {"--log"}} {
		if _, err := parseOptions(args); err == nil {
			t.Fatalf("accepted invalid args %v", args)
		}
	}
	if o, err := parseOptions([]string{"--installto=D:\\Apps"}); err != nil || o.Directory != `D:\Apps` {
		t.Fatal("equals path not parsed")
	}
}

func TestDirectoryRiskArgumentStaysInOuterInstaller(t *testing.T) {
	parsed, err := parseOptions([]string{"--silent", "--accept-directory-risk", "--installto", "chosen", "--log", "setup.log", "--", "--say", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if !parsed.AcceptDirectoryRisk || !parsed.Silent {
		t.Fatalf("missing explicit authorization: %+v", parsed)
	}
	want := []string{"--installto", "chosen", "--silent", "--log", "setup.log", "--", "--say", "hello"}
	if got := installerArguments(parsed, parsed.Directory); !reflect.DeepEqual(got, want) {
		t.Fatalf("inner installer arguments = %v, want %v", got, want)
	}
	plain, err := parseOptions([]string{"--silent"})
	if err != nil || plain.AcceptDirectoryRisk {
		t.Fatalf("silent implicitly authorized risk: %+v, %v", plain, err)
	}
	if _, err := parseOptions([]string{"--accept-directory-risk=true"}); err == nil {
		t.Fatal("accepted unsupported risk authorization syntax")
	}
}

func TestAuthorizeDirectoryRisks(t *testing.T) {
	root := t.TempDir()
	risks := []directoryRisk{{Path: root, Principal: "S-1-5-32-545", Mask: 0x001f01ff, Reason: "access"}}
	text := messages{
		Risk: "Installation directory: {{path}}", RiskEntry: "{{path}} | {{principal}} | {{reason}} | {{mask}}",
		RiskSilent: "Explicit directory risk authorization required", RiskQuestion: "Continue?",
	}
	for _, scenario := range []struct {
		name         string
		risks        []directoryRisk
		options      options
		confirm      bool
		wantAccepted bool
		wantError    bool
		wantCalls    int
	}{
		{name: "safe-interactive", wantAccepted: true},
		{name: "safe-silent", options: options{Silent: true}, wantAccepted: true},
		{name: "silent-refuses-implicit-consent", risks: risks, options: options{Silent: true}, wantError: true},
		{name: "silent-explicit-consent", risks: risks, options: options{Silent: true, AcceptDirectoryRisk: true}, wantAccepted: true},
		{name: "interactive-accept", risks: risks, confirm: true, wantAccepted: true, wantCalls: 1},
		{name: "interactive-cancel", risks: risks, wantCalls: 1},
		{name: "interactive-flag-does-not-skip-confirmation", risks: risks, options: options{AcceptDirectoryRisk: true}, wantCalls: 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			calls := 0
			accepted, err := authorizeDirectoryRisks(root, scenario.risks, scenario.options, text, func(prompt string) bool {
				calls++
				for _, required := range []string{root, risks[0].Principal, "0x001f01ff"} {
					if !strings.Contains(prompt, required) {
						t.Errorf("confirmation omitted %q: %q", required, prompt)
					}
				}
				if strings.Contains(prompt, "%!") || strings.Contains(prompt, "{{") {
					t.Errorf("invalid risk formatting: %q", prompt)
				}
				return scenario.confirm
			})
			if accepted != scenario.wantAccepted || (err != nil) != scenario.wantError || calls != scenario.wantCalls {
				t.Fatalf("accepted=%v err=%v confirmations=%d; want %v, error=%v, confirmations=%d", accepted, err, calls, scenario.wantAccepted, scenario.wantError, scenario.wantCalls)
			}
		})
	}
}
