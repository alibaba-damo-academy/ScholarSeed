package main

import (
	"errors"
	"testing"
	"time"
)

func TestWaitRemoval(t *testing.T) {
	for _, tc := range []struct {
		name    string
		states  []removalState
		timeout bool
	}{
		{"fresh", []removalState{{absent: true}}, false},
		{"installed", []removalState{{complete: true}}, false},
		{"dialog then delayed cleanup", []removalState{{active: true, incomplete: true}, {incomplete: true}, {}, {absent: true}}, false},
		{"empty before process exit", []removalState{{active: true, absent: true}, {absent: true}}, false},
		{"healthy updater exits", []removalState{{active: true, complete: true}, {complete: true}}, false},
		{"uninstaller deletes updater before root", []removalState{{active: true, complete: true}, {}, {absent: true}}, false},
		{"dialog still open", []removalState{{active: true, incomplete: true}}, true},
		{"cleanup stuck", []removalState{{incomplete: true}, {}}, true},
		{"new contents before delayed delete", []removalState{{incomplete: true}, {complete: true}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Unix(0, 0)
			calls := 0
			err := waitRemoval(`D:\tt`, func() (removalState, error) {
				i := calls
				calls++
				if i >= len(tc.states) {
					i = len(tc.states) - 1
				}
				return tc.states[i], nil
			}, func() time.Time { return now }, func(d time.Duration) { now = now.Add(d) })
			var issue *directoryIssue
			if tc.timeout {
				if !errors.As(err, &issue) || issue.Code != directoryUninstall {
					t.Fatalf("expected incomplete uninstall: %v", err)
				}
			} else if err != nil || calls != len(tc.states) {
				t.Fatalf("continued early or failed: calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestWaitRemovalPropagatesInspectionFailure(t *testing.T) {
	failure := errors.New("cannot inspect")
	err := waitRemoval("root", func() (removalState, error) { return removalState{}, failure }, time.Now, func(time.Duration) { t.Fatal("slept after inspection error") })
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
}
