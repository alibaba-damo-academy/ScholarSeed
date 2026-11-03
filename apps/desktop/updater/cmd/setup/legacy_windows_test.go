package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unicode/utf16"
)

func environmentFixture(value string, kind uint32) legacyEnvironment {
	words := append(utf16.Encode([]rune(value)), 0)
	raw := make([]byte, len(words)*2)
	for i, w := range words {
		binary.LittleEndian.PutUint16(raw[i*2:], w)
	}
	return legacyEnvironment{true, kind, raw}
}
func TestLegacyEnvironmentPreservesTypeAbsenceAndBytes(t *testing.T) {
	absent := legacyEnvironment{}
	empty := environmentFixture("", syscall.REG_SZ)
	if absent.equal(empty) {
		t.Fatal("missing and empty values were merged")
	}
	value := environmentFixture(`D:\中文 数据\.scholarseed`, syscall.REG_SZ)
	actual, err := value.value()
	if err != nil || actual != `D:\中文 数据\.scholarseed` {
		t.Fatalf("%q %v", actual, err)
	}
	expanded := environmentFixture(`D:\中文 数据\.scholarseed`, syscall.REG_EXPAND_SZ)
	if value.equal(expanded) {
		t.Fatal("registry type was ignored")
	}
	changed := value
	changed.raw = append([]byte(nil), value.raw...)
	changed.raw[0] = 'E'
	if value.equal(changed) {
		t.Fatal("registry value change was ignored")
	}
	malformed := environmentFixture("a\x00b", syscall.REG_SZ)
	if _, err = malformed.value(); err == nil {
		t.Fatal("embedded NUL accepted")
	}
	t.Setenv("SCHOLARSEED_TEST_HOME", `D:\expanded`)
	expand := environmentFixture(`%SCHOLARSEED_TEST_HOME%\data`, syscall.REG_EXPAND_SZ)
	actual, err = expand.value()
	if err != nil || actual != `D:\expanded\data` {
		t.Fatalf("%q %v", actual, err)
	}
	if !bytes.Equal(expand.raw, environmentFixture(`%SCHOLARSEED_TEST_HOME%\data`, syscall.REG_EXPAND_SZ).raw) {
		t.Fatal("expansion mutated stored bytes")
	}
}
func TestLegacyEnvironmentForChildDoesNotPersistOrDuplicateHome(t *testing.T) {
	snapshot := environmentFixture(`D:\数据\.scholarseed`, syscall.REG_SZ)
	migration := legacyInstallation{home: snapshot}
	got := migration.environment([]string{"PATH=unchanged", "scholarseed_home=stale"})
	if len(got) != 2 || got[0] != "PATH=unchanged" || got[1] != legacyHomeName+`=D:\数据\.scholarseed` {
		t.Fatalf("%q", got)
	}
	if !migration.home.equal(snapshot) {
		t.Fatal("child projection mutated registry snapshot")
	}
	migration.processHome = `E:\explicit`
	got = migration.environment(nil)
	if len(got) != 1 || got[0] != legacyHomeName+`=E:\explicit` {
		t.Fatalf("%q", got)
	}
}
func TestLegacyPathOverlapUsesBoundaries(t *testing.T) {
	for _, pair := range [][2]string{{`D:\App`, `d:\app`}, {`D:\App`, `D:\App\Data`}, {`D:\App\Data`, `D:\App`}} {
		if !legacyOverlap(pair[0], pair[1]) {
			t.Fatal(pair)
		}
	}
	for _, pair := range [][2]string{{`D:\App`, `D:\Application`}, {`D:\App`, `E:\App`}} {
		if legacyOverlap(pair[0], pair[1]) {
			t.Fatal(pair)
		}
	}
}
func TestLegacySourceRequiresAllOriginalDigests(t *testing.T) {
	root := t.TempDir()
	// Digest admission assumes an application-owned tree. t.TempDir inherits
	// the runner's ACL, which may grant Users child creation on a shared drive.
	owner := installationOwner(t)
	setPermissionFixture(t, root, "D:P(A;OICI;FA;;;"+owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err := os.Mkdir(filepath.Join(root, "resources"), 0700); err != nil {
		t.Fatal(err)
	}
	product := `{"product_id":"scholarseed","bundle_id":"com.scholarseed.desktop","build_number":"202610091639","release_lane":"distribution","update_channel":"release"}`
	data := map[string]string{legacyUninstaller: "test-only-uninstaller", `resources\product.json`: product, `resources\app.asar`: "test-only-archive"}
	digest := func(value string) string { sum := sha256.Sum256([]byte(value)); return hex.EncodeToString(sum[:]) }
	for name, value := range data {
		if err := os.WriteFile(filepath.Join(root, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	migration := legacyInstallation{root: root, policy: legacyPolicy{legacyBuild, legacyCommit, digest(data[legacyUninstaller]), digest(product), digest(data[`resources\app.asar`]), strings.Repeat("a", 64)}}
	for name, value := range data {
		migration.inventory = append(migration.inventory, legacyFile{filepath.ToSlash(name), int64(len(value)), digest(value)})
	}
	if err := migration.verifySource(); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(root, "user-paper.pdf")
	if err := os.WriteFile(extra, []byte("user asset"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migration.verifySource(); err == nil {
		t.Fatal("accepted user file inside old installation")
	}
	if err := os.Remove(extra); err != nil {
		t.Fatal(err)
	}
	extra = filepath.Join(root, "user-project")
	if err := os.Mkdir(extra, 0700); err != nil {
		t.Fatal(err)
	}
	if err := migration.verifySource(); err == nil {
		t.Fatal("accepted extra user project directory")
	}
	if err := os.Remove(extra); err != nil {
		t.Fatal(err)
	}
	for name, value := range data {
		file := filepath.Join(root, name)
		if err := os.WriteFile(file, []byte(value+"changed"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := migration.verifySource(); err == nil {
			t.Fatalf("accepted modified %s", name)
		}
		if err := os.WriteFile(file, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Even a policy whose product digest matches must retain release identity.
	wrong := strings.Replace(product, legacyBuild, "202610091640", 1)
	if err := os.WriteFile(filepath.Join(root, `resources\product.json`), []byte(wrong), 0600); err != nil {
		t.Fatal(err)
	}
	migration.policy.ProductSHA256 = digest(wrong)
	for i := range migration.inventory {
		if migration.inventory[i].Path == "resources/product.json" {
			migration.inventory[i].SHA256 = digest(wrong)
			migration.inventory[i].Size = int64(len(wrong))
		}
	}
	if err := migration.verifySource(); err == nil {
		t.Fatal("accepted other release with matching digest")
	}
}
func TestLegacyWorkerCannotRunWithoutCompiledPolicy(t *testing.T) {
	for _, args := range [][]string{nil, {"anything"}, {"a", "b"}} {
		if err := legacyWorker(configuration{}, args); err == nil {
			t.Fatal("worker accepted missing policy")
		}
	}
}

func TestLegacyHookHomeUsesUnexpandedNSISValue(t *testing.T) {
	migration := legacyInstallation{root: `D:\Old App`, homes: []string{`C:\Users\User\.scholarseed`}}
	got, err := migration.hookHome()
	if err != nil || got != migration.homes[0] {
		t.Fatalf("%q %v", got, err)
	}
	migration.home = environmentFixture(`%USERPROFILE%\.scholarseed`, syscall.REG_EXPAND_SZ)
	got, err = migration.hookHome()
	if err != nil || got != `D:\Old App\%USERPROFILE%\.scholarseed` {
		t.Fatalf("%q %v", got, err)
	}
	migration.home = environmentFixture(`E:\Data\.scholarseed`, syscall.REG_SZ)
	got, err = migration.hookHome()
	if err != nil || got != `E:\Data\.scholarseed` {
		t.Fatalf("%q %v", got, err)
	}
	for _, path := range []string{`%HOME%\..\..\other`, `D:relative`, strings.Repeat("x", 1024)} {
		migration.home = environmentFixture(path, syscall.REG_EXPAND_SZ)
		if _, err = migration.hookHome(); err == nil {
			t.Fatalf("accepted unsafe legacy path %q", path)
		}
	}
}

func TestLegacyLaunchGateBlocksReadButAllowsRetirement(t *testing.T) {
	const sharingViolation = syscall.Errno(32)
	root := t.TempDir()
	filename := filepath.Join(root, "ScholarSeed.exe")
	if err := os.WriteFile(filename, []byte("test image"), 0600); err != nil {
		t.Fatal(err)
	}
	migration := legacyInstallation{root: root}
	gate, err := migration.lockStart()
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	// Probe an ordinary reader, not Go's backup-intent open: CI's SSH token
	// may have SeBackupPrivilege enabled and legitimately bypass sharing.
	reader, err := syscall.CreateFile(utf(filename), syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err == nil {
		syscall.CloseHandle(reader)
		t.Fatal("old image still readable while migration gate is held")
	} else if err != sharingViolation {
		t.Fatalf("ordinary reader must fail with sharing violation: %v", err)
	}
	renamed := filepath.Join(root, "retired.exe")
	if err = os.Rename(filename, renamed); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(renamed); err != nil {
		t.Fatal(err)
	}
}
