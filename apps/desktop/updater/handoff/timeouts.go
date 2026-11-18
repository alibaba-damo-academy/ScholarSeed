package handoff

import (
	_ "embed"
	"encoding/json"
	"time"
)

//go:embed timeouts.json
var timeoutPolicyJSON []byte

type handoffTimeouts struct {
	OperationMS            int64 `json:"operationMs"`
	WorkerStopMS           int64 `json:"workerStopMs"`
	CoordinatorExitGraceMS int64 `json:"coordinatorExitGraceMs"`
}

var timeoutPolicy = func() handoffTimeouts {
	var policy handoffTimeouts
	if err := json.Unmarshal(timeoutPolicyJSON, &policy); err != nil ||
		policy.OperationMS <= 0 || policy.WorkerStopMS <= 0 || policy.CoordinatorExitGraceMS <= 0 {
		panic("invalid Windows updater timeout policy")
	}
	return policy
}()

var WorkerWait = time.Duration(timeoutPolicy.OperationMS) * time.Millisecond
var WorkerStopWait = time.Duration(timeoutPolicy.WorkerStopMS) * time.Millisecond
