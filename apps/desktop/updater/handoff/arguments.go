package handoff

import (
	"errors"
	"strconv"
	"strings"
)

const (
	restartArgumentLimit      = 4
	restartArgumentBytes      = 4096
	restartProfileSwitch      = "--user-data-dir"
	restartDebugAddressSwitch = "--remote-debugging-address"
	restartDebugPortSwitch    = "--remote-debugging-port"
	restartDebugLoopback      = "127.0.0.1"
	restartDebugPortBits      = 16
)

// Accept only the canonical argv emitted by Desktop's updateDebugArguments.
// The explicit loopback address and port must travel together; no arbitrary
// Chromium switches or implicit listening address cross the native boundary.
func validateRestartArguments(args []string) error {
	if len(args) > restartArgumentLimit {
		return errors.New("restart arguments exceed limit")
	}
	seen := make(map[string]bool, len(args))
	for _, arg := range args {
		if len(arg) > restartArgumentBytes || strings.ContainsRune(arg, 0) {
			return errors.New("unsupported restart argument")
		}
		key, value, ok := strings.Cut(arg, "=")
		if !ok || value == "" || seen[key] {
			return errors.New("unsupported restart argument")
		}
		seen[key] = true
		switch key {
		case restartProfileSwitch:
		case restartDebugAddressSwitch:
			if value != restartDebugLoopback {
				return errors.New("unsupported restart argument")
			}
		case restartDebugPortSwitch:
			for _, digit := range value {
				if digit < '0' || digit > '9' {
					return errors.New("unsupported restart argument")
				}
			}
			if _, err := strconv.ParseUint(value, 10, restartDebugPortBits); err != nil {
				return errors.New("unsupported restart argument")
			}
		default:
			return errors.New("unsupported restart argument")
		}
	}
	if seen[restartDebugAddressSwitch] != seen[restartDebugPortSwitch] {
		return errors.New("incomplete restart debug arguments")
	}
	return nil
}
