//go:build !windows

package handoff

func (p Policy) RecoverSandbox(string, string, string, uint32, string) (SandboxResult, error) {
	return SandboxResult{}, errWindows
}
