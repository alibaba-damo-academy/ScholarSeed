//go:build !windows

package handoff

func activateVelopack(string) error { return errWindows }
