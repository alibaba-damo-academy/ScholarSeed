package security

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

func TestRejectionPreservesCauseAndSanitizes(t *testing.T) {
	before := os.Stderr
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = writer
	defer func() { os.Stderr = before; reader.Close(); writer.Close() }()
	original := errors.New("credential-secret S-1-5-21-private")
	wrapped := Reject("tool_owner", "owner", "untrusted_owner", original, "C:/secret/profile")
	if !errors.Is(wrapped, original) || wrapped.Error() != original.Error() {
		t.Fatal("original failure changed")
	}
	if Reject("tool_writer", "acl", "policy_denied", wrapped, "") != wrapped {
		t.Fatal("first diagnostic replaced")
	}
	writer.Close()
	raw, _ := io.ReadAll(reader)
	if strings.Contains(string(raw), "credential-secret") || strings.Contains(string(raw), "S-1-5-21-private") || strings.Contains(string(raw), "C:/secret") {
		t.Fatal("diagnostic exposed content")
	}
	var event map[string]any
	if json.Unmarshal(raw, &event) != nil || event["correlation_id"] == "" || event["reason"] != "untrusted_owner" {
		t.Fatal("missing structured context")
	}
}

func TestNativeRejectionReasons(t *testing.T) {
	for code, want := range map[uint32]string{5: "os_access_denied", 1223: "authorization_cancelled", 1300: "privilege_not_held", 1314: "privilege_not_held"} {
		if got := DiagnosticSystemReason(code); got != want {
			t.Fatalf("code=%d got=%s", code, got)
		}
	}
}
