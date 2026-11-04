//go:build !windows

package handoff

func updateWindow(_ map[string]UpdateMessages, run func(func(ComponentProgress)) error) error {
	return run(nil)
}
