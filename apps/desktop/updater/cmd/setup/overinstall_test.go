package main

import (
	"errors"
	"testing"
	"time"
)

func TestWaitInstallationExit(t *testing.T) {
	for _, tc := range []struct {
		name    string
		active  int
		failure error
		want    error
	}{
		{"already-exited", 0, nil, nil}, {"draining", 3, nil, nil}, {"timeout", 100000, nil, errSetupBusy},
		{"unknown-occupancy", 1, errors.New("query denied"), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Unix(0, 0)
			calls := 0
			err := waitInstallationExit(func() (bool, error) { calls++; return calls <= tc.active, tc.failure }, func() time.Time { return now }, func(d time.Duration) { now = now.Add(d) })
			if tc.failure != nil {
				if !errors.Is(err, tc.failure) {
					t.Fatal(err)
				}
			} else if !errors.Is(err, tc.want) {
				t.Fatal(err)
			}
			if tc.active == 0 && calls != 1 {
				t.Fatal("idle install waited")
			}
		})
	}
}
func TestSetupPipeIdentity(t *testing.T) {
	if setupPipe(`C:\Apps\书深\`) != setupPipe(`c:\apps\书深`) {
		t.Fatal("case changed endpoint")
	}
	if setupPipe(`C:\Apps\one`) == setupPipe(`C:\Apps\two`) {
		t.Fatal("installations share endpoint")
	}
}
