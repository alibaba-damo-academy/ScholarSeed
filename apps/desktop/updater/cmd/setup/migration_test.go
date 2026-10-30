package main

import (
	"errors"
	"testing"
)

func TestLegacyRemovalRechecksBeforeFreshInstallation(t *testing.T) {
	attempts, prompts := 0, 0
	old := errors.New("unsafe old directory")
	result, err := waitLegacy(func() (*legacyInstallation, error) {
		attempts++
		if attempts == 1 {
			return nil, old
		}
		return nil, nil
	}, func(err error) bool { prompts++; return errors.Is(err, old) }, false)
	if err != nil || result != nil || attempts != 2 || prompts != 1 {
		t.Fatalf("result=%v error=%v checks=%d prompts=%d", result, err, attempts, prompts)
	}
}
func TestLegacyRemovalSilentNeverPromptsOrIgnoresFailure(t *testing.T) {
	old := errors.New("old installation still exists")
	_, err := waitLegacy(func() (*legacyInstallation, error) { return nil, old }, func(error) bool {
		t.Fatal("silent installation prompted")
		return true
	}, true)
	if !errors.Is(err, old) {
		t.Fatalf("lost original failure: %v", err)
	}
}
func TestLegacyRemovalCancellationDoesNotAuthorizeInstallation(t *testing.T) {
	checks := 0
	_, err := waitLegacy(func() (*legacyInstallation, error) { checks++; return nil, errors.New("old client") }, func(error) bool { return false }, false)
	if !errors.Is(err, errLegacyCancelled) || checks != 1 {
		t.Fatalf("%v checks=%d", err, checks)
	}
}

func TestLegacyRemovalMessageSeparatesOldPathAndTargetFailure(t *testing.T) {
	text := messages{LegacyRemoval: "old={{path}}; cause={{detail}}", LegacyUnknown: "unknown", Unsafe: "foreign writer"}
	err := &legacyIssue{Path: `D:\scholarseed`, Cause: errUnsafePermissions}
	got := formatLegacyRemoval(text, err)
	if got != `old=D:\scholarseed; cause=foreign writer` {
		t.Fatalf("%q", got)
	}
	if !errors.Is(err, errUnsafePermissions) {
		t.Fatal("lost original diagnostic")
	}
	if got = formatLegacyRemoval(text, errors.New("registry unreadable")); got != "old=unknown; cause=registry unreadable" {
		t.Fatalf("%q", got)
	}
}

func TestLegacyRemovalReturnsQualifiedMigrationWithoutPrompt(t *testing.T) {
	migration := &legacyInstallation{}
	result, err := waitLegacy(func() (*legacyInstallation, error) { return migration, nil }, func(error) bool { t.Fatal("qualified migration prompted"); return false }, false)
	if err != nil || result != migration {
		t.Fatalf("%v %v", result, err)
	}
}
