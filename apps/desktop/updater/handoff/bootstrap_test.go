package handoff

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func launcherPolicy() LauncherPolicy {
	p := testPolicy()
	p.RuntimeSHA256 = strings.Repeat("a", 64)
	p.Signing = Signing{Mode: "unsigned-dev"}
	text := StartupMessages{Title: "ScholarSeed", Brand: "ScholarSeed", Elapsed: "Waiting:", Preparing: "Preparing", Verifying: "Verifying", Downloading: "Downloading {{name}} {{percent}}%", Failed: "Failed", Retry: "Retry", Exit: "Exit", Stopping: "Stopping", Cancel: "Cancel"}
	return LauncherPolicy{Schema: Schema, Policy: p, ComponentBaseURL: "https://updates.example", VelopackDLLSHA256: strings.Repeat("b", 64), Messages: map[string]StartupMessages{"en": text, "zh": text}}
}

func TestLauncherPolicy(t *testing.T) {
	encode := func(p LauncherPolicy) string {
		raw, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		return base64.StdEncoding.EncodeToString(raw)
	}
	if _, err := ParseLauncherPolicy(encode(launcherPolicy())); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*LauncherPolicy){
		"http":             func(p *LauncherPolicy) { p.ComponentBaseURL = "http://updates.example" },
		"credentials":      func(p *LauncherPolicy) { p.ComponentBaseURL = "https://a:b@updates.example" },
		"query":            func(p *LauncherPolicy) { p.ComponentBaseURL = "https://updates.example/?redirect=x" },
		"library":          func(p *LauncherPolicy) { p.VelopackDLLSHA256 = "invalid" },
		"manifest":         func(p *LauncherPolicy) { p.Policy.RuntimeSHA256 = "invalid" },
		"identity":         func(p *LauncherPolicy) { p.Policy.AppID = "other" },
		"untrusted-signed": func(p *LauncherPolicy) { p.Policy.Signing = Signing{Mode: "authenticode", Publisher: "untrusted"} },
		"brand":            func(p *LauncherPolicy) { m := p.Messages["en"]; m.Brand = ""; p.Messages["en"] = m },
		"elapsed":          func(p *LauncherPolicy) { m := p.Messages["zh"]; m.Elapsed = ""; p.Messages["zh"] = m },
		"language":         func(p *LauncherPolicy) { delete(p.Messages, "zh") },
		"message":          func(p *LauncherPolicy) { m := p.Messages["en"]; m.Downloading = "Downloading"; p.Messages["en"] = m },
	} {
		t.Run(name, func(t *testing.T) {
			p := launcherPolicy()
			mutate(&p)
			if _, err := ParseLauncherPolicy(encode(p)); err == nil {
				t.Fatal("invalid compiled policy accepted")
			}
		})
	}
}

func TestBootstrapRejectsForeignRoot(t *testing.T) {
	p := launcherPolicy().Policy
	if _, err := p.Bootstrap(context.Background(), t.TempDir(), "https://updates.example", nil); err == nil {
		t.Fatal("accepted arbitrary root outside current launcher")
	}
}
