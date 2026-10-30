package main

import "testing"

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
