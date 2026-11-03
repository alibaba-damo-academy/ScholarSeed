package handoff

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPublishUninstallerForInstallAndUpdate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "书深 install")
	current := filepath.Join(root, "current")
	if err := os.MkdirAll(current, 0700); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"first signed bytes", "next signed bytes"} {
		if err := os.WriteFile(filepath.Join(current, Uninstaller), []byte(version), 0600); err != nil {
			t.Fatal(err)
		}
		if err := publishUninstallerIn(current); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(root, Uninstaller))
		if err != nil || string(raw) != version {
			t.Fatalf("publication changed executable bytes: %s %v", raw, err)
		}
		entries, err := os.ReadDir(root)
		if err != nil || len(entries) != 2 {
			t.Fatalf("publication left temporary files: %v %v", entries, err)
		}
	}
}

func TestPublishRejectsMissingSourceAndWrongLayout(t *testing.T) {
	root := t.TempDir()
	if err := publishUninstallerIn(root); err == nil {
		t.Fatal("non-installed layout accepted")
	}
	current := filepath.Join(root, "current")
	if err := os.Mkdir(current, 0700); err != nil {
		t.Fatal(err)
	}
	if err := publishUninstallerIn(current); err == nil {
		t.Fatal("missing source accepted")
	}
	if _, err := os.Stat(filepath.Join(root, Uninstaller)); !os.IsNotExist(err) {
		t.Fatal("entry created without source")
	}
}
