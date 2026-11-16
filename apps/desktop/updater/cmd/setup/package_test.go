package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func packageFixture(t *testing.T, names ...string) ([]byte, replacementPackage) {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range names {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte("official updater")); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data := append([]byte("engine"), buffer.Bytes()...)
	fullDigest := sha256.Sum256(buffer.Bytes())
	updaterDigest := sha256.Sum256([]byte("official updater"))
	return data, replacementPackage{Offset: 6, Size: buffer.Len(), SHA256: hex.EncodeToString(fullDigest[:]), UpdaterSize: 16, UpdaterSHA256: hex.EncodeToString(updaterDigest[:])}
}

func TestEmbeddedPackageExtraction(t *testing.T) {
	data, policy := packageFixture(t, setupUpdaterMember, "../not-extracted")
	root := t.TempDir()
	full, updater, release, err := preparePackage(root, data, policy)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for name, expected := range map[string][]byte{full: data[policy.Offset:], updater: []byte("official updater")} {
		actual, err := os.ReadFile(name)
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "not-extracted")); !os.IsNotExist(err) {
		t.Fatal("extracted a member other than the fixed updater")
	}
	if _, _, close, err := preparePackage(root, data, policy); err == nil {
		close()
		t.Fatal("overwrote a prepared input")
	}
}

func TestEmbeddedPackageRejectsCorruption(t *testing.T) {
	data, policy := packageFixture(t, setupUpdaterMember)
	for _, change := range []func(*replacementPackage){
		func(p *replacementPackage) { p.Offset = -1 },
		func(p *replacementPackage) { p.Offset = len(data) + 1 },
		func(p *replacementPackage) { p.Size = len(data) },
		func(p *replacementPackage) { p.SHA256 = "wrong" },
		func(p *replacementPackage) { p.UpdaterSize++ },
		func(p *replacementPackage) { p.UpdaterSHA256 = "wrong" },
	} {
		candidate := policy
		change(&candidate)
		if _, _, release, err := preparePackage(t.TempDir(), data, candidate); err == nil {
			release()
			t.Fatal("accepted changed package policy")
		}
	}
	for _, members := range [][]string{{"elsewhere.exe"}, {setupUpdaterMember, setupUpdaterMember}} {
		data, policy := packageFixture(t, members...)
		if _, _, release, err := preparePackage(t.TempDir(), data, policy); err == nil {
			release()
			t.Fatal("accepted absent or ambiguous updater")
		}
	}
}
