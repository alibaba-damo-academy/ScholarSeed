package handoff

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestUpdateRefreshesIconsBeforeLaunching(t *testing.T) {
	executable := "installed/current/ScholarSeed.exe"
	args := []string{"--user-data-dir=profile with spaces"}
	var calls []string
	var diagnostics bytes.Buffer
	err := restartUpdatedApplication(executable, args, func(path string) error {
		if path != executable {
			t.Fatalf("refresh path: %q", path)
		}
		calls = append(calls, "refresh")
		return nil
	}, func(path string, actual []string) (int, error) {
		if path != executable || !reflect.DeepEqual(actual, args) {
			t.Fatalf("launch changed: %q %q", path, actual)
		}
		calls = append(calls, "launch")
		return 1234, nil
	}, &restartDiagnostics{writer: &diagnostics, updateID: "test", from: "old", to: "new"})
	if err != nil || !reflect.DeepEqual(calls, []string{"refresh", "launch"}) {
		t.Fatalf("restart: calls=%v err=%v diagnostics=%q", calls, err, diagnostics.String())
	}
	events := readRestartEvents(t, &diagnostics)
	var names []string
	for _, event := range events {
		names = append(names, event.Event)
		if event.TimestampUTC == "" || event.PID <= 0 || event.UpdateID != "test" || event.FromVersion != "old" || event.ToVersion != "new" || event.ElapsedMS < 0 {
			t.Fatalf("missing correlation: %+v", event)
		}
	}
	if !reflect.DeepEqual(names, []string{"icon_refresh.start", "icon_refresh.notified", "application_restart.start", "application_restart.started"}) || events[3].ChildPID != 1234 {
		t.Fatalf("unexpected events: %+v", events)
	}
	if events[1].NotificationMode != restartNotificationMode || events[3].NotificationMode != "" {
		t.Fatalf("notification details missing or attached to launch: %+v", events)
	}
}

func TestUpdateStillLaunchesAndDiagnosesIconRefreshFailure(t *testing.T) {
	refreshErr := errors.New("Shell notification unavailable")
	var diagnostics bytes.Buffer
	launched := false
	err := restartUpdatedApplication("installed.exe", nil, func(string) error {
		return refreshErr
	}, func(string, []string) (int, error) {
		launched = true
		if !strings.Contains(diagnostics.String(), refreshErr.Error()) {
			t.Fatal("refresh failure was not diagnosed before launch")
		}
		return 1234, nil
	}, &restartDiagnostics{writer: &diagnostics})
	if err != nil || !launched {
		t.Fatalf("icon refresh prevented recovery: launched=%v err=%v", launched, err)
	}
}

func TestUpdatePreservesLaunchFailure(t *testing.T) {
	launchErr := errors.New("application launch denied")
	var diagnostics bytes.Buffer
	err := restartUpdatedApplication("installed.exe", nil, func(string) error {
		return errors.New("icon refresh failed")
	}, func(string, []string) (int, error) {
		return 0, launchErr
	}, &restartDiagnostics{writer: &diagnostics})
	if !errors.Is(err, launchErr) || diagnostics.Len() == 0 {
		t.Fatalf("launch failure lost: err=%v diagnostics=%q", err, diagnostics.String())
	}
	events := readRestartEvents(t, &diagnostics)
	if events[len(events)-1].Event != "application_restart.failed" || events[len(events)-1].Error != launchErr.Error() {
		t.Fatalf("launch error not recorded: %+v", events)
	}
}

func readRestartEvents(t *testing.T, source io.Reader) []restartEvent {
	t.Helper()
	decoder := json.NewDecoder(source)
	var events []restartEvent
	for {
		var event restartEvent
		if err := decoder.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) {
				return events
			}
			t.Fatal(err)
		}
		events = append(events, event)
	}
}

type failedRestartWriter struct{}

func (failedRestartWriter) Write([]byte) (int, error) { return 0, errors.New("disk unavailable") }

func TestUpdateLaunchSurvivesDiagnosticWriteFailure(t *testing.T) {
	launched := false
	diagnostics := &restartDiagnostics{writer: failedRestartWriter{}}
	err := restartUpdatedApplication("installed.exe", nil, func(string) error {
		return errors.New("notification unavailable")
	}, func(string, []string) (int, error) {
		launched = true
		return 1234, nil
	}, diagnostics)
	if err != nil || !launched || !diagnostics.writeFailed {
		t.Fatalf("diagnostic failure changed restart: launched=%v err=%v", launched, err)
	}
}
