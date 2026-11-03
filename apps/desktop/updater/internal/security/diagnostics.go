package security

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
)

// Rejection preserves the original error for errors.Is/As and the existing UI.
// Only bounded categories, numeric system codes and a resource digest are logged.
type Rejection struct {
	Cause    error
	Incident string
}

func (e *Rejection) Error() string { return e.Cause.Error() }
func (e *Rejection) Unwrap() error { return e.Cause }
func Reject(profile, stage, reason string, cause error, resource string) error {
	if cause == nil {
		return nil
	}
	var previous *Rejection
	if errors.As(cause, &previous) {
		return cause
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return cause
	}
	incident := hex.EncodeToString(nonce[:])
	var system syscall.Errno
	errors.As(cause, &system)
	if native := DiagnosticSystemReason(uint32(system)); runtime.GOOS == "windows" && native != "" {
		reason = native
	} else if runtime.GOOS != "windows" && system == syscall.EACCES {
		reason = "os_access_denied"
	} else if system != 0 {
		reason = "os_error"
	}

	event := map[string]any{"schema": DiagnosticSchema, "event": DiagnosticEvent, "policy_hash": PolicyHash,
		"profile": DiagnosticProfile(profile), "stage": DiagnosticStage(stage), "reason": DiagnosticReason(reason),
		"code": "permission_denied", "system_code": uint32(system), "error_type": fmt.Sprintf("%T", cause), "correlation_id": incident, "pid": os.Getpid(), "subject_kind": DiagnosticSubject(reason)}
	if _, file, line, ok := runtime.Caller(1); ok {
		event["site"] = map[string]any{"file": filepath.Base(file), "line": line}
	}
	if resource != "" {
		digest := sha256.Sum256([]byte(resource))
		event["target_id"] = hex.EncodeToString(digest[:8])
	}
	if raw, err := json.Marshal(event); err == nil {
		_, _ = fmt.Fprintln(os.Stderr, string(raw))
	}
	return &Rejection{cause, incident}
}
