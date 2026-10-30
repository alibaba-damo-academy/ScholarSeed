//go:build windows

package handoff

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

const restartArgumentsOutput = "SCHOLARSEED_TEST_RESTART_ARGUMENTS_OUTPUT"

func TestRestartArgumentsChild(t *testing.T) {
	if len(os.Args) < 3 || os.Args[2] != "--" {
		return
	}
	raw, err := json.Marshal(os.Args[3:])
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(os.Getenv(restartArgumentsOutput), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRestartArgumentsWindowsRoundTrip(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "argv.json")
	t.Setenv(restartArgumentsOutput, output)
	args := []string{`--user-data-dir=C:\Users\测试 user\profile\`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19340"}
	if err = validateRestartArguments(args); err != nil {
		t.Fatal(err)
	}
	// Use the native restart implementation and an isolated child test process;
	// this proves Windows quoting, not signed application update acceptance.
	if _, err = restart(executable, append([]string{"-test.run=^TestRestartArgumentsChild$", "--"}, args...)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(output)
		if readErr == nil {
			var actual []string
			if err = json.Unmarshal(raw, &actual); err == nil {
				if !reflect.DeepEqual(actual, args) {
					t.Fatalf("restart argv: got %q, want %q", actual, args)
				}
				return
			}
		} else if !os.IsNotExist(readErr) {
			t.Fatal(readErr)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("restart child did not publish argv")
}
