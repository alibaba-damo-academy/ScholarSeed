package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestLegacyPolicyRejectsNonreleaseAndMissingDigests(t *testing.T) {
	digest := strings.Repeat("a", 64)
	p := legacyPolicy{legacyBuild, legacyCommit, digest, digest, digest, digest}
	if err := validateLegacyPolicy(&p); err != nil {
		t.Fatal(err)
	}
	if err := validateLegacyPolicy(nil); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*legacyPolicy){
		func(p *legacyPolicy) { p.Build = "202610091640" },
		func(p *legacyPolicy) { p.Commit = strings.Repeat("0", 40) },
		func(p *legacyPolicy) { p.UninstallerSHA256 = "" },
		func(p *legacyPolicy) { p.ProductSHA256 = strings.Repeat("A", 64) },
		func(p *legacyPolicy) { p.AsarSHA256 = strings.Repeat("0", 64) },
	} {
		changed := p
		mutate(&changed)
		if validateLegacyPolicy(&changed) == nil {
			t.Fatal("accepted invalid legacy policy")
		}
	}
}
func TestLegacyDigestRejectsChangedSource(t *testing.T) {
	data := "original signed executable"
	sum := sha256.Sum256([]byte(data))
	digest := hex.EncodeToString(sum[:])
	if err := verifyLegacyDigest(strings.NewReader(data), digest); err != nil {
		t.Fatal(err)
	}
	if verifyLegacyDigest(strings.NewReader(data+"modified"), digest) == nil {
		t.Fatal("accepted modified executable")
	}
}
func TestLegacyProductIdentity(t *testing.T) {
	data := `{"product_id":"scholarseed","bundle_id":"com.scholarseed.desktop","build_number":"202610091639","release_lane":"distribution","update_channel":"release"}`
	if err := verifyLegacyProduct([]byte(data)); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{legacyBuild, "202610091640"}, {"distribution", "local"}, {"release\"", "preview\""}, {"com.scholarseed.desktop", "other"}} {
		if verifyLegacyProduct([]byte(strings.ReplaceAll(data, pair[0], pair[1]))) == nil {
			t.Fatal("accepted wrong product identity")
		}
	}
}
func TestLegacyArgumentsKeepFinalDirectoryUnquoted(t *testing.T) {
	for _, machine := range []bool{false, true} {
		got, err := legacyArguments(`D:\书深 Apps\ScholarSeed`, machine)
		if err != nil {
			t.Fatal(err)
		}
		scope := "/currentuser"
		if machine {
			scope = "/allusers"
		}
		want := `/S /KEEP_APP_DATA ` + scope + ` --updated _?=D:\书深 Apps\ScholarSeed`
		if got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	}
	for _, root := range []string{`D:\`, `relative`, `\\server\share`, "D:\\app\n/evil", `D:\app"`} {
		if _, err := legacyArguments(root, false); err == nil {
			t.Fatalf("accepted %q", root)
		}
	}
}

func TestLegacyInventoryIsAuthenticatedAndHasUniqueSafeMembers(t *testing.T) {
	file := legacyFile{"resources/app.asar", 7, strings.Repeat("a", 64)}
	encode := func(files []legacyFile) ([]byte, *legacyPolicy) {
		raw, err := json.Marshal(files)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		return raw, &legacyPolicy{InventorySHA256: hex.EncodeToString(sum[:])}
	}
	raw, policy := encode([]legacyFile{file})
	if _, err := parseLegacyInventory(raw, policy); err != nil {
		t.Fatal(err)
	}
	if _, err := parseLegacyInventory(append(raw, ' '), policy); err == nil {
		t.Fatal("accepted changed inventory bytes")
	}
	for _, files := range [][]legacyFile{nil, {file, file}, {{"resources/../escape", 7, file.SHA256}}, {{"D:/escape", 7, file.SHA256}}, {{"resources", 0, file.SHA256}, file}, {{"resources/APP.asar", 7, file.SHA256}, file}, {{"resources/app.asar", -1, file.SHA256}}, {{"resources/app.asar", 1, "invalid"}}} {
		raw, policy = encode(files)
		if _, err := parseLegacyInventory(raw, policy); err == nil {
			t.Fatalf("accepted invalid inventory %v", files)
		}
	}
}
