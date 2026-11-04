package handoff

import (
	"errors"
	"fmt"
	"strings"
)

func validateUpdateMessages(messages map[string]UpdateMessages) error {
	if len(messages) != 2 {
		return errors.New("missing compiled update languages")
	}
	for _, language := range []string{"en", "zh"} {
		text := messages[language]
		for _, value := range []string{text.Title, text.Brand, text.Elapsed, text.Preparing, text.Failed, text.Exit,
			text.Checking, text.Extracting, text.Publishing, text.Ready, text.Installing, text.Restarting} {
			if value == "" || len(value) > 4096 || strings.ContainsRune(value, 0) {
				return errors.New("invalid compiled update message")
			}
		}
		for _, parameter := range []string{"{{name}}", "{{percent}}", "{{count}}", "{{total}}"} {
			if !strings.Contains(text.Extracting, parameter) {
				return errors.New("missing compiled update progress parameter")
			}
		}
	}
	return nil
}

const (
	updateInstalling = "installing"
	updateRestarting = "restarting"
)

// Finish presentation before launching an application that must replace this
// fixed cached helper. In particular, a recovered worker failure must not leave
// its modal notice holding the executable open after the old app starts.
func presentUpdate(run func(func(ComponentProgress)) (func() error, error), present func(func(func(ComponentProgress)) error) error) error {
	var resume func() error
	outcome := present(func(observe func(ComponentProgress)) error {
		var err error
		resume, err = run(observe)
		return err
	})
	if resume == nil {
		return outcome
	}
	if err := resume(); err != nil {
		// No application started, so it is safe to retain the failure notice.
		return present(func(func(ComponentProgress)) error { return errors.Join(outcome, err) })
	}
	return outcome
}

// Committed interruptions keep the coordinator's stricter recovery notice.
// The progress view must not replace it with ordinary failure/reopen advice.
func deferUpdateFailure(err error) bool {
	var recovery *UpdateRecoveryError
	return errors.As(err, &recovery)
}

// UpdateMessages is frozen into the helper, never supplied by an update request.
type UpdateMessages struct {
	StartupMessages
	Checking   string `json:"checking"`
	Publishing string `json:"publishing"`
	Ready      string `json:"ready"`
	Installing string `json:"installing"`
	Restarting string `json:"restarting"`
}

func (text UpdateMessages) progress(event ComponentProgress) BootstrapProgress {
	result := BootstrapProgress{}
	name := event.Kind
	if name == "texlive" {
		name = "TeX Live"
	}
	template := text.Checking
	switch event.Phase {
	case "extracting":
		template = text.Extracting
		result.Phase = BootstrapPreparing
		result.Total = max(int64(0), event.TotalBytes)
		result.Received = min(result.Total, max(int64(0), event.Bytes))
	case "publishing":
		template = text.Publishing
	case "reused", "complete":
		template = text.Ready
	case updateInstalling:
		template = text.Installing
	case updateRestarting:
		template = text.Restarting
	}
	percent := int64(0)
	if result.Total > 0 {
		percent = result.Received * 100 / result.Total
	}
	result.Text = strings.NewReplacer("{{name}}", name, "{{percent}}", fmt.Sprint(percent),
		"{{count}}", fmt.Sprint(max(0, event.Files)), "{{total}}", fmt.Sprint(max(0, event.TotalFiles))).Replace(template)
	return result
}
