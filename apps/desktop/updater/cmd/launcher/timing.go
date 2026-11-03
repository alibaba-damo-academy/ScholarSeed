package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"time"

	"scholarseed.local/desktop/updater/handoff"
)

const callbackTimingFlag = "--scholarseed-callback-timing="
const callbackTimingSchema = 1
const callbackFingerprintLength = 16

type callbackTiming struct {
	Schema      int     `json:"schema"`
	Attempt     string  `json:"attempt"`
	PID         int     `json:"launcher_pid"`
	StartedAtMS int64   `json:"started_at_ms"`
	ActivateMS  float64 `json:"activate_ms"`
	BootstrapMS float64 `json:"bootstrap_ms"`
	SignatureMS float64 `json:"signature_ms"`
	ReadinessMS float64 `json:"readiness_ms"`
	PreEngineMS float64 `json:"pre_engine_ms"`
	started     time.Time
}

func newCallbackTiming(args []string) *callbackTiming {
	for _, argument := range args {
		parsed := callbackURL(argument)
		if parsed == nil || parsed.Query().Get("code") == "" || parsed.Query().Get("state") == "" {
			continue
		}
		started := time.Now()
		return &callbackTiming{Schema: callbackTimingSchema, Attempt: handoff.Hash([]byte(parsed.Query().Get("state")))[:callbackFingerprintLength],
			PID: os.Getpid(), StartedAtMS: started.UnixMilli(), started: started}
	}
	return nil
}

func (timing *callbackTiming) activationDone(started time.Time) {
	if timing != nil {
		timing.ActivateMS = float64(time.Since(started)) / float64(time.Millisecond)
	}
}

func (timing *callbackTiming) observe(event handoff.ComponentTiming) {
	if timing == nil || event.Operation != "bootstrap" {
		return
	}
	timing.BootstrapMS = event.ElapsedMS
	timing.SignatureMS = event.Metrics["signature"].ElapsedMS
	timing.ReadinessMS = event.Metrics["readiness"].ElapsedMS
}

func (timing *callbackTiming) argument() string {
	if timing == nil {
		return ""
	}
	timing.PreEngineMS = float64(time.Since(timing.started)) / float64(time.Millisecond)
	raw, err := json.Marshal(timing)
	if err != nil {
		return ""
	}
	return callbackTimingFlag + base64.RawURLEncoding.EncodeToString(raw)
}
