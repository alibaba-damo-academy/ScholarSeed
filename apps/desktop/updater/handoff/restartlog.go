package handoff

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const restartLogName = "native-update.log"
const restartLogDirectory = "logs"
const restartLogMaxBytes = 4 * 1024 * 1024
const restartLogKeepBytes = 1024 * 1024
const restartErrorBytes = 1024
const restartNotificationMode = "SHCNE_UPDATEITEM|SHCNE_ASSOCCHANGED;SHCNF_FLUSH"

type restartEvent struct {
	SchemaVersion    int     `json:"schemaVersion"`
	TimestampUTC     string  `json:"timestampUtc"`
	UpdateID         string  `json:"updateId"`
	FromVersion      string  `json:"fromVersion"`
	ToVersion        string  `json:"toVersion"`
	PID              int     `json:"pid"`
	ChildPID         int     `json:"childPid,omitempty"`
	Event            string  `json:"event"`
	NotificationMode string  `json:"notificationMode,omitempty"`
	ElapsedMS        float64 `json:"elapsedMs"`
	Error            string  `json:"error,omitempty"`
}

type restartDiagnostics struct {
	writer             io.Writer
	file               *os.File
	parents            []*os.File
	updateID, from, to string
	writeFailed        bool
}

// Desktop supplies the active Home's log path. This unelevated coordinator pins
// its ancestors and opens a regular single-link file without following a leaf
// redirect. Never derive Home from the worker's environment or installation.
func openRestartDiagnostics(request, filename, from, to string) *restartDiagnostics {
	name := filepath.Base(request)
	d := &restartDiagnostics{writer: os.Stderr, from: from, to: to,
		updateID: strings.TrimSuffix(strings.TrimPrefix(name, "request-"), ".json")}
	if !requestName.MatchString(name) || !filepath.IsAbs(filename) || filepath.Clean(filename) != filename || filepath.Base(filename) != restartLogName || filepath.Base(filepath.Dir(filename)) != restartLogDirectory {
		d.record("diagnostics.failed", time.Now(), 0, fmt.Errorf("invalid update diagnostic path"))
		return d
	}
	parents, err := pinLineage(filepath.Dir(filename))
	if err != nil {
		d.record("diagnostics.failed", time.Now(), 0, err)
		return d
	}
	file, err := openRestartLog(filename)
	if err != nil {
		closeFiles(parents)
		d.record("diagnostics.failed", time.Now(), 0, err)
		return d
	}
	d.file, d.writer, d.parents = file, file, parents
	// Preserve any historical native updater diagnostics, even an unterminated
	// last line. Append after it instead of overwriting the existing log.
	if info, statErr := file.Stat(); statErr == nil && info.Size() > 0 {
		last := []byte{0}
		if _, readErr := file.ReadAt(last, info.Size()-1); readErr == nil && last[0] != '\n' {
			_, err = file.Write([]byte{'\n'})
		}
	} else {
		err = statErr
	}
	if err != nil {
		d.writeFailed = true
		fmt.Fprintf(os.Stderr, "Windows update diagnostic initialization failed: %v\n", err)
	}
	return d
}

// Compact through the already-qualified handle; never rename/reopen a path or
// delete backups while another product process may be collecting diagnostics.
func compactRestartLog(file *os.File, incoming int) error {
	info, err := file.Stat()
	if err != nil || info.Size()+int64(incoming) <= restartLogMaxBytes {
		return err
	}
	tail := make([]byte, restartLogKeepBytes)
	n, err := file.ReadAt(tail, info.Size()-restartLogKeepBytes)
	if err != nil {
		return err
	}
	tail = tail[:n]
	if newline := strings.IndexByte(string(tail), '\n'); newline >= 0 {
		tail = tail[newline+1:]
	} else {
		tail = nil
	}
	if err = file.Truncate(0); err != nil {
		return err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err = file.Write(tail)
	return err
}

func (d *restartDiagnostics) record(event string, started time.Time, childPID int, eventErr error) {
	entry := restartEvent{SchemaVersion: 1, TimestampUTC: time.Now().UTC().Format(time.RFC3339Nano),
		UpdateID: d.updateID, FromVersion: d.from, ToVersion: d.to, PID: os.Getpid(),
		ChildPID: childPID, Event: event, ElapsedMS: float64(time.Since(started)) / float64(time.Millisecond)}
	switch event {
	case iconRefreshStart, iconRefreshFailed, iconRefreshNotified:
		entry.NotificationMode = restartNotificationMode
	}
	if eventErr != nil {
		// Bounded diagnostics never include launch argv, credentials or envelopes.
		entry.Error = eventErr.Error()
		if len(entry.Error) > restartErrorBytes {
			entry.Error = entry.Error[:restartErrorBytes]
		}
	}
	raw, err := json.Marshal(entry)
	if err == nil && d.file != nil {
		err = compactRestartLog(d.file, len(raw)+1)
	}
	if err == nil {
		_, err = d.writer.Write(append(raw, '\n'))
	}
	if err == nil && d.file != nil {
		err = d.file.Sync()
	}
	if err != nil && !d.writeFailed {
		d.writeFailed = true
		fmt.Fprintf(os.Stderr, "Windows update diagnostic write failed: %v\n", err)
	}
}

func (d *restartDiagnostics) close() {
	if d.file != nil {
		if err := d.file.Close(); err != nil {
			fmt.Fprintf(os.Stderr, "Windows update diagnostic close failed: %v\n", err)
		}
	}
	closeFiles(d.parents)
}
