package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveInstalledUpdater(t *testing.T) {
	root := filepath.Join(t.TempDir(), "书深 with spaces")
	if err := os.MkdirAll(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{updaterName, "current/sq.version"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, location := range []string{"Uninstall.exe", "current/Uninstall.exe"} {
		got, err := updater(filepath.Join(root, location))
		if err != nil || got != filepath.Join(root, updaterName) {
			t.Fatalf("%s: %s %v", location, got, err)
		}
	}
	if err := os.Remove(filepath.Join(root, updaterName)); err != nil {
		t.Fatal(err)
	}
	if _, err := updater(filepath.Join(root, "Uninstall.exe")); err == nil {
		t.Fatal("missing updater accepted")
	}
}
func TestRejectArgumentsBeforeLaunch(t *testing.T) {
	for _, args := range [][]string{{"--rootDir", "elsewhere"}, {"/S"}, {"--silent", "--silent"}} {
		if err := launch("missing", args); err == nil || err.Error() != "only --silent is supported" {
			t.Fatal(err)
		}
	}
}

func TestInstallationRootMayBeNamedCurrent(t *testing.T) {
	root := filepath.Join(t.TempDir(), "current")
	if err := os.MkdirAll(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{updaterName, "current/sq.version"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := updater(filepath.Join(root, "Uninstall.exe"))
	if err != nil || got != filepath.Join(root, updaterName) {
		t.Fatalf("custom installation root: %s %v", got, err)
	}
}
