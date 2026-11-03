//go:build windows

package handoff

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"
)

func TestUpdaterJobChild(t *testing.T) {
	if os.Args[len(os.Args)-1] == "handoff-job-child" {
		os.Exit(0)
	}
}

func TestUpdaterJobAuthorizesBeforeAtomicLaunch(t *testing.T) {
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(random[:])
	job, err := newUpdateJob(nonce)
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	invocation, err := openUpdaterJob(nonce)
	if err != nil {
		t.Fatal(err)
	}
	defer invocation.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = invocation.Run(executable, []string{"-test.run=^TestUpdaterJobChild$", "handoff-job-child"}); err != nil {
		t.Fatal(err)
	}
	if err = job.Quiesce(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err = openUpdaterJob(nonce + "missing"); err == nil {
		t.Fatal("accepted nonexistent job")
	}
}
