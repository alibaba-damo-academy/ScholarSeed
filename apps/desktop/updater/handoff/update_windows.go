package handoff

import "context"

func updateWindow(messages map[string]UpdateMessages, run func(func(ComponentProgress)) error) error {
	language := "en"
	locale, _, _ := kernel.NewProc("GetUserDefaultUILanguage").Call()
	if locale&0x3ff == 4 {
		language = "zh"
	}
	text := messages[language]
	_, err := runProgressWindow(text.StartupMessages, func(_ context.Context, observe func(BootstrapProgress)) (BootstrapResult, error) {
		// Closing the window and presentation deadlines cannot cancel a commit.
		err := run(func(event ComponentProgress) { observe(text.progress(event)) })
		return BootstrapResult{}, err
	}, true)
	return err
}
