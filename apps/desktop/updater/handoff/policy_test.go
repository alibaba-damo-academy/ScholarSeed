package handoff

import "testing"

func TestRecoveryMessagesRequireBothCompleteLanguages(testContext *testing.T) {
	complete := RecoveryMessages{Title: "title", Stopped: "stopped", Unconfirmed: "unconfirmed"}
	valid := Policy{RecoveryMessages: map[string]RecoveryMessages{"en": complete, "zh": complete}}
	if err := valid.ValidateRecoveryMessages(); err != nil {
		testContext.Fatal(err)
	}
	for _, sample := range []map[string]RecoveryMessages{
		nil,
		{"en": complete},
		{"en": complete, "other": complete},
		{"en": complete, "zh": {Title: "title", Unconfirmed: "unconfirmed"}},
		{"en": complete, "zh": {Title: "\x00", Stopped: "stopped", Unconfirmed: "unconfirmed"}},
	} {
		if err := (Policy{RecoveryMessages: sample}).ValidateRecoveryMessages(); err == nil {
			testContext.Fatal("incomplete or unsafe recovery messages were accepted")
		}
	}
}
