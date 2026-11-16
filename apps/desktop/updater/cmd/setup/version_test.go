package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReplacementVersion(t *testing.T) {
	const installed = "0.3.2-build.202611091617"
	for _, tc := range []struct {
		name, candidate    string
		downgrade, invalid bool
	}{
		{"higher-patch", "0.3.3-build.202611090000", false, false},
		{"higher-minor", "0.10.0-build.202611090000", false, false},
		{"higher-build", "0.3.2-build.202611091618", false, false},
		{"same-repair", installed, false, false},
		{"older-build", "0.3.2-build.202611091616", true, false},
		{"older-product-newer-build", "0.3.1-build.202611101617", true, false},
		{"invalid", "garbage", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, "current"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "current", "sq.version"), []byte("<package><metadata><id>scholarseed</id><version>"+installed+"</version></metadata></package>"), 0600); err != nil {
				t.Fatal(err)
			}
			config := configuration{AppID: "scholarseed", PackVersion: tc.candidate}
			err := validateReplacementVersion(root, config)
			if (validateReplacedVersion(root, config) == nil) != (tc.candidate == installed) {
				t.Fatal("installed result identity mismatch was accepted")
			}
			if errors.Is(err, errReplacementDowngrade) != tc.downgrade || (err != nil) != (tc.downgrade || tc.invalid) {
				t.Fatalf("unexpected result: %v", err)
			}
		})
	}
}
func TestReplacementRejectsUnknownIdentity(t *testing.T) {
	root := t.TempDir()
	c := configuration{AppID: "scholarseed", PackVersion: "0.3.3-build.202611091617"}
	if err := validateReplacementVersion(root, c); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"broken", "<package><metadata><id>other</id><version>0.3.2-build.202611091617</version></metadata></package>", "<package><metadata><id>scholarseed</id><version>unknown</version></metadata></package>"} {
		if err := os.WriteFile(filepath.Join(root, "current", "sq.version"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateReplacementVersion(root, c); err == nil {
			t.Fatal("unknown identity accepted")
		}
	}
}
func TestReplacementDowngradeUsesSelectedLanguage(t *testing.T) {
	if got := directoryError(messages{Downgrade: "localized downgrade"}, errReplacementDowngrade); got != "localized downgrade" {
		t.Fatal(got)
	}
}
