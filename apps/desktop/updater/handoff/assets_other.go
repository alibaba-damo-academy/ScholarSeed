//go:build !windows

package handoff

func RetireApplicationTools(string) error { return errWindows }

func (p Policy) applicationToolsReady(string, Runtime, string) (bool, error) {
	return false, errWindows
}

func (p Policy) admitApplicationTools(string, Runtime, string) error {
	return errWindows
}
