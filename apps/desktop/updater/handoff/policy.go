// Package handoff owns fixed Windows installation operations and bounded sandbox
// ownership recovery. It deliberately has no legacy updater dependencies.
package handoff

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf16"
)

const (
	Schema                       = 1
	ManifestLimit                = 32 * 1024 * 1024
	PackageLimit           int64 = 32 * 1024 * 1024 * 1024
	ExpandedLimit          int64 = 128 * 1024 * 1024 * 1024
	FileLimit                    = 500000
	PathLimit                    = 259
	RuntimeManifest              = "resources/components/runtime.json"
	HelperRelative               = "current/resources/handoff/handoff.exe"
	ReceiptName                  = ".scholarseed-component.json"
	ArchiveDirectory             = "runtime/.archives"
	ArchiveTemporarySuffix       = ".part-000000000000"
)

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var versionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)
var componentVersionPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,62}-r[1-9][0-9]*$`)
var kindPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
var devicePattern = regexp.MustCompile(`(?i)^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])($|\.)`)

type Policy struct {
	UpdateMessages   map[string]UpdateMessages `json:"update_messages"`
	observeTiming    func(ComponentTiming)
	observeProgress  func(ComponentProgress)
	toolAdmission    *toolAdmission
	Schema           int                         `json:"schema"`
	ProductID        string                      `json:"product_id"`
	BundleID         string                      `json:"bundle_id"`
	AppID            string                      `json:"app_id"`
	Target           string                      `json:"target"`
	Channel          string                      `json:"channel"`
	PackVersion      string                      `json:"pack_version"`
	Executable       string                      `json:"executable"`
	RuntimeSHA256    string                      `json:"runtime_sha256"`
	Keys             map[string]string           `json:"keys"`
	Signing          Signing                     `json:"signing"`
	RecoveryMessages map[string]RecoveryMessages `json:"recovery_messages"`
}
type RecoveryMessages struct {
	Title       string `json:"title"`
	Stopped     string `json:"stopped"`
	Unconfirmed string `json:"unconfirmed"`
}

func (policy Policy) ValidateRecoveryMessages() error {
	if len(policy.RecoveryMessages) != 2 {
		return errors.New("compiled recovery messages require both languages")
	}
	for _, language := range []string{"en", "zh"} {
		messages, exists := policy.RecoveryMessages[language]
		if !exists {
			return errors.New("compiled recovery language is missing")
		}
		for _, message := range []string{messages.Title, messages.Stopped, messages.Unconfirmed} {
			if strings.TrimSpace(message) == "" || strings.ContainsRune(message, '\x00') {
				return errors.New("compiled recovery message is invalid")
			}
		}
	}
	return nil
}

type Signing struct {
	Mode      string `json:"mode"`
	Publisher string `json:"publisher,omitempty"`
}

type Envelope struct {
	Schema    int    `json:"schema"`
	KeyID     string `json:"key_id"`
	Manifest  string `json:"manifest"`
	Signature string `json:"signature"`
}

func Decode(data []byte, value any) error {
	if len(data) == 0 || len(data) > ManifestLimit {
		return errors.New("JSON exceeds limit")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if err := d.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func ParsePolicy(encoded string) (Policy, error) {
	var p Policy
	raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return p, err
	}
	if err = Decode(raw, &p); err != nil {
		return p, err
	}
	if err = validateUpdateMessages(p.UpdateMessages); err != nil {
		return p, err
	}
	if p.Schema != Schema || p.ProductID == "" || p.BundleID == "" || p.AppID != "scholarseed" || p.Target != "win32-x86_64" || p.Channel == "" || !digestPattern.MatchString(p.RuntimeSHA256) || p.Executable != "ScholarSeed.exe" {
		return p, errors.New("invalid compiled policy")
	}
	if len(p.Keys) > 8 {
		return p, errors.New("too many keys")
	}
	if p.Signing.Mode != "unsigned-dev" && (p.Signing.Mode != "authenticode" || p.Signing.Publisher == "" || len(p.Keys) == 0) {
		return p, errors.New("invalid compiled signing policy")
	}
	for id, encoded := range p.Keys {
		key, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(key) != ed25519.PublicKeySize || !versionPattern.MatchString(id) {
			return p, errors.New("invalid compiled public key")
		}
	}
	if _, err := versionNumbers(p.PackVersion); err != nil {
		return p, err
	}
	return p, nil
}

func Hash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func (p Policy) authenticate(raw []byte, baseline bool) ([]byte, error) {
	// Initial installation trusts only this build's exact frozen bytes.
	if baseline {
		if Hash(raw) != p.RuntimeSHA256 {
			return nil, errors.New("initial runtime manifest differs from compiled build")
		}
		var envelope Envelope
		if Decode(raw, &envelope) == nil && envelope.Manifest != "" {
			return base64.StdEncoding.Strict().DecodeString(envelope.Manifest)
		}
		return raw, nil
	}
	var e Envelope
	if err := Decode(raw, &e); err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.Strict().DecodeString(p.Keys[e.KeyID])
	if err != nil || len(key) != ed25519.PublicKeySize || e.Schema != Schema {
		return nil, errors.New("untrusted envelope key")
	}
	message, err := base64.StdEncoding.Strict().DecodeString(e.Manifest)
	if err != nil || len(message) > ManifestLimit {
		return nil, errors.New("invalid signed manifest")
	}
	sig, err := base64.StdEncoding.Strict().DecodeString(e.Signature)
	if err != nil || !ed25519.Verify(key, message, sig) {
		return nil, errors.New("invalid manifest signature")
	}
	return message, nil
}

func memberPath(name string) error {
	if name == "" || strings.ContainsAny(name, "\\:<>\"|?*\x00") || strings.HasPrefix(name, "/") {
		return fmt.Errorf("unsafe member %q", name)
	}
	for _, ch := range name {
		if ch < 32 || ch == 127 {
			return errors.New("control character in member")
		}
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || devicePattern.MatchString(part) || len(utf16.Encode([]rune(part))) > 255 {
			return fmt.Errorf("unsafe member %q", name)
		}
	}
	return nil
}

func checkedPath(root, relative string) (string, error) {
	if err := memberPath(relative); err != nil {
		return "", err
	}
	full := joinPath(root, relative)
	if len(utf16.Encode([]rune(full))) > PathLimit {
		return "", fmt.Errorf("Windows path exceeds %d characters: %s", PathLimit, full)
	}
	return full, nil
}
