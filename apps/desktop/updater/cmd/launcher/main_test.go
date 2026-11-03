package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"scholarseed.local/desktop/updater/handoff"
)

func TestCallbackTimingContainsOnlyBoundedDiagnostics(test *testing.T) {
	timing := newCallbackTiming([]string{`"scholarseed://auth/callback?code=SECRET_CODE&state=SECRET_STATE"`})
	if timing == nil {
		test.Fatal("callback timing was not started")
	}
	timing.activationDone(time.Now())
	timing.observe(handoff.ComponentTiming{Operation: "bootstrap", ElapsedMS: 42, Metrics: map[string]handoff.TimingMetric{"signature": {Calls: 1, ElapsedMS: 12}, "readiness": {Calls: 1, ElapsedMS: 5}}})
	argument := timing.argument()
	encoded := strings.TrimPrefix(argument, callbackTimingFlag)
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		test.Fatal(err)
	}
	var record map[string]any
	if err = json.Unmarshal(raw, &record); err != nil {
		test.Fatal(err)
	}
	if record["attempt"] != handoff.Hash([]byte("SECRET_STATE"))[:16] || record["signature_ms"] != float64(12) || record["bootstrap_ms"] != float64(42) {
		test.Fatal(record)
	}
	for _, secret := range []string{"SECRET_CODE", "SECRET_STATE", "scholarseed://", "publisher", "path"} {
		if strings.Contains(string(raw), secret) {
			test.Fatal("timing leaked callback data")
		}
	}
	for _, args := range [][]string{nil, {"https://example.test/?code=a&state=b"}, {"scholarseed://auth/callback?state=a"}} {
		if timing := newCallbackTiming(args); timing != nil || timing.argument() != "" {
			test.Fatal("ordinary startup gained callback telemetry")
		}
	}
}

func TestPublicNoninteractiveEntries(t *testing.T) {
	for _, flag := range []string{"--package-check", "--shoot", "--mode-check", "--say", "--drive", "--workbench-check"} {
		if interactive([]string{flag, "value"}, "") {
			t.Fatalf("%s would block on a retry dialog", flag)
		}
	}
	if interactive(nil, "1") {
		t.Fatal("Node mode would show startup UI")
	}
	for _, args := range [][]string{nil, {"--unknown"}, {"--user-data-dir=example"}, {"scholarseed://callback"}} {
		if !interactive(args, "") {
			t.Fatal("normal startup lost interactive recovery")
		}
	}
}

func TestLoginCallbackSkipsProgressButRetainsFailureUI(t *testing.T) {
	for _, args := range [][]string{
		{"scholarseed://auth/callback?code=test&state=test"},
		{"--user-data-dir=C:/Users/Test Profile", `"scholarseed://auth/callback?code=test&state=test"`},
		{"'SCHOLARSEED://AUTH/callback?code=test&state=test'"},
		{"scholarseed://auth/callback"},
	} {
		if startupProgress(args, "") || !interactive(args, "") {
			t.Fatalf("callback should suppress progress but retain interactive errors: %v", args)
		}
	}
}

func TestStartupProgressPreservesOrdinaryAndHeadlessLaunches(t *testing.T) {
	for _, args := range [][]string{
		nil, {"document.txt"}, {"--user-data-dir=example"},
		{"https://auth/callback"}, {"scholarseed://other/callback"},
		{"scholarseed://auth/callback/extra"}, {"scholarseed://auth/%63allback"},
		{"https://example.test/scholarseed://auth/callback"},
		{"--data=scholarseed://auth/callback"}, {"scholarseed://auth/%zz"},
	} {
		if !startupProgress(args, "") {
			t.Fatalf("ordinary invocation lost startup progress: %v", args)
		}
	}
	for _, flag := range []string{"--package-check", "--shoot", "--mode-check", "--say", "--drive", "--workbench-check"} {
		if startupProgress([]string{flag, "value"}, "") {
			t.Fatalf("headless invocation gained startup progress: %s", flag)
		}
	}
	if startupProgress(nil, "1") {
		t.Fatal("Node mode gained startup progress")
	}
}
