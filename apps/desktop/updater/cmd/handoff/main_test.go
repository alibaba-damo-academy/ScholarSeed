package main

import (
	"errors"
	"fmt"
	"testing"

	"scholarseed.local/desktop/updater/handoff"
)

func TestOnlyTheOriginalCoordinatorPresentsInterruptedUpdates(testContext *testing.T) {
	failure := &handoff.UpdateRecoveryError{ProcessesExited: true, Cause: errors.New("update interrupted")}
	for _, sample := range []struct {
		name    string
		request string
		worker  string
		failure error
		visible bool
	}{
		{name: "coordinator", request: "request", failure: failure, visible: true},
		{name: "wrapped", request: "request", failure: fmt.Errorf("handoff: %w", failure), visible: true},
		{name: "worker", worker: "request", failure: failure},
		{name: "ambiguous", request: "request", worker: "request", failure: failure},
		{name: "ordinary failure", request: "request", failure: errors.New("authorization refused")},
		{name: "success", request: "request"},
	} {
		testContext.Run(sample.name, func(subtest *testing.T) {
			actual := recoveryFailure(sample.request, sample.worker, sample.failure)
			if (actual != nil) != sample.visible {
				subtest.Fatalf("recovery visibility differs: %v", actual)
			}
			if actual != nil && actual != failure {
				subtest.Fatal("recovery diagnostics were replaced")
			}
		})
	}
}
