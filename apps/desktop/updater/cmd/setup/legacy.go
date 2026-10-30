package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path"
	"strings"
)

const legacyBuild = "202610091639"
const legacyCommit = "b8a938849f0be71d7b3d92830b8a4988722435d7"
const legacyGUID = "b37a0805-d862-5fec-aab9-cb527040f854"
const legacyUninstaller = "Uninstall ScholarSeed.exe"
const legacyHomeName = "SCHOLARSEED_HOME"

// These digests are measured from the original signed release, never from a
// discovered installation. A missing policy permits fresh installs but no legacy
// uninstall. The outer Setup signature authenticates this compiled allowlist.
type legacyPolicy struct {
	Build             string `json:"build"`
	Commit            string `json:"commit"`
	UninstallerSHA256 string `json:"uninstallerSha256"`
	ProductSHA256     string `json:"productSha256"`
	AsarSHA256        string `json:"asarSha256"`
	InventorySHA256   string `json:"inventorySha256"`
}

const legacyIdentityExit = 21

var errLegacyIdentity = errors.New("approve legacy removal with the same Windows account that started Setup")

var errLegacyUnsupported = errors.New("legacy installation is not the supported release")
var errLegacyRunning = errors.New("close ScholarSeed and its runtime processes before migration")
var errLegacyChanged = errors.New("legacy installation or data configuration changed; retry migration")

func validateLegacyPolicy(p *legacyPolicy) error {
	if p == nil {
		return nil
	}
	if p.Build != legacyBuild || p.Commit != legacyCommit {
		return errLegacyUnsupported
	}
	for _, digest := range []string{p.UninstallerSHA256, p.ProductSHA256, p.AsarSHA256, p.InventorySHA256} {
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) || digest == strings.Repeat("0", sha256.Size*2) {
			return errLegacyUnsupported
		}
	}
	return nil
}

func verifyLegacyDigest(r io.Reader, expected string) error {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != expected {
		return errLegacyUnsupported
	}
	return nil
}

func verifyLegacyProduct(data []byte) error {
	var product struct {
		ID      string `json:"product_id"`
		Bundle  string `json:"bundle_id"`
		Build   string `json:"build_number"`
		Channel string `json:"update_channel"`
		Lane    string `json:"release_lane"`
	}
	if err := json.Unmarshal(data, &product); err != nil {
		return errLegacyUnsupported
	}
	if product.ID != "scholarseed" || product.Bundle != "com.scholarseed.desktop" || product.Build != legacyBuild || product.Channel != "release" || product.Lane != "distribution" {
		return errLegacyUnsupported
	}
	return nil
}

// NSIS consumes the unquoted trailing _?= as the installation directory. Do not
// pass this through argv escaping or a shell: a space is part of this final path.
func legacyArguments(root string, machine bool) (string, error) {
	if len(root) < 4 || root[1:3] != `:\` || strings.ContainsAny(root, "\x00\r\n\"") {
		return "", errLegacyUnsupported
	}
	scope := "/currentuser"
	if machine {
		scope = "/allusers"
	}
	return "/S /KEEP_APP_DATA " + scope + " --updated _?=" + root, nil
}

// The build replaces only this private-copy input with the measured original
// release inventory. Its digest is authenticated by the compiled policy.
//
//go:embed legacy-files.json
var legacyInventory []byte

type legacyFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func parseLegacyInventory(raw []byte, policy *legacyPolicy) ([]legacyFile, error) {
	if policy == nil {
		return nil, errLegacyUnsupported
	}
	if err := verifyLegacyDigest(strings.NewReader(string(raw)), policy.InventorySHA256); err != nil {
		return nil, err
	}
	var inventory []legacyFile
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&inventory); err != nil {
		return nil, err
	}
	if len(inventory) == 0 || len(inventory) > 100000 {
		return nil, errLegacyUnsupported
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errLegacyUnsupported
	}
	seen := make(map[string]bool, len(inventory))
	for _, file := range inventory {
		if file.Path == "." || path.IsAbs(file.Path) || path.Clean(file.Path) != file.Path || strings.HasPrefix(file.Path, "../") || strings.ContainsAny(file.Path, `\:`+"\x00\r\n") || file.Size < 0 {
			return nil, errLegacyUnsupported
		}
		for _, part := range strings.Split(file.Path, "/") {
			if part == "" || strings.TrimRight(part, " .") != part {
				return nil, errLegacyUnsupported
			}
		}
		key := strings.ToLower(file.Path)
		if seen[key] {
			return nil, errLegacyUnsupported
		}
		seen[key] = true
		digest, err := hex.DecodeString(file.SHA256)
		if err != nil || len(digest) != sha256.Size || file.SHA256 != strings.ToLower(file.SHA256) {
			return nil, errLegacyUnsupported
		}
	}
	for key := range seen {
		for parent := path.Dir(key); parent != "."; parent = path.Dir(parent) {
			if seen[parent] {
				return nil, errLegacyUnsupported
			}
		}
	}
	return inventory, nil
}
