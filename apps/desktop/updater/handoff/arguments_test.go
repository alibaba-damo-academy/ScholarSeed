package handoff

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRestartArgumentsPreserveLocalDebugging(t *testing.T) {
	for _, port := range []int{0, 19340, 65535} {
		t.Run(fmt.Sprint(port), func(t *testing.T) {
			args := []string{`--user-data-dir=C:\Users\测试 user\profile`, "--remote-debugging-address=127.0.0.1", fmt.Sprintf("--remote-debugging-port=%d", port)}
			if err := validateRestartArguments(args); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRestartArgumentsWithoutDebugging(t *testing.T) {
	for _, args := range [][]string{nil, {}, {`--user-data-dir=C:\Users\test user\profile`}} {
		if err := validateRestartArguments(args); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRestartArgumentsRejectUnsafeOrAmbiguousInputs(t *testing.T) {
	for name, args := range map[string][]string{
		"nonlocal":          {"--remote-debugging-address=0.0.0.0", "--remote-debugging-port=19340"},
		"hostname":          {"--remote-debugging-address=localhost", "--remote-debugging-port=19340"},
		"address only":      {"--remote-debugging-address=127.0.0.1"},
		"port only":         {"--remote-debugging-port=19340"},
		"duplicate port":    {"--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19340", "--remote-debugging-port=9222"},
		"duplicate address": {"--remote-debugging-address=127.0.0.1", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19340"},
		"duplicate profile": {"--user-data-dir=a", "--user-data-dir=b"},
		"empty profile":     {"--user-data-dir="},
		"split":             {"--remote-debugging-port", "19340"},
		"pipe":              {"--remote-debugging-pipe"},
		"unknown":           {"--disable-web-security"},
		"nul":               {"--user-data-dir=a\x00b"},
		"too long":          {"--user-data-dir=" + strings.Repeat("a", 4096)},
		"too many":          {"--user-data-dir=a", "--user-data-dir=b", "--user-data-dir=c", "--user-data-dir=d", "--user-data-dir=e"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateRestartArguments(args); err == nil {
				t.Fatal("accepted", args)
			}
		})
	}
	for _, port := range []string{"", "-1", "+1", "65536", "1.5", "1e3", "0x50", " 80", "80 ", "80\n", "NaN", "１２３", "999999999999999999999999"} {
		t.Run("port="+port, func(t *testing.T) {
			if err := validateRestartArguments([]string{"--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port}); err == nil {
				t.Fatal("accepted", port)
			}
		})
	}
}

// Exercise the producer and consumer together so a new Desktop switch cannot
// silently drift from the native coordinator's allowlist again.
func TestRestartArgumentsFromDesktopProducer(t *testing.T) {
	producer, err := filepath.Abs("../../src/main/debuglaunch.ts")
	if err != nil {
		t.Fatal(err)
	}
	script := `
import { pathToFileURL } from 'node:url';
const { updateDebugArguments } = await import(pathToFileURL(process.argv[1]).href);
const inputs = [[], ['--remote-debugging-pipe'],
 ['--remote-debugging-port=19340', '--remote-debugging-address=127.0.0.1'],
 ['--remote-debugging-port', '0', '--remote-debugging-address', 'localhost'],
 ['--remote-debugging-port=65535', '--remote-debugging-address=::1'],
 ['--remote-debugging-port=9222', '--remote-debugging-address=0.0.0.0']];
console.log(JSON.stringify(inputs.map(argv => ['--user-data-dir=C:\\Users\\test user\\profile', ...updateDebugArguments(argv)])));
`
	output, err := exec.Command("node", "--experimental-strip-types", "--input-type=module", "-e", script, producer).Output()
	if err != nil {
		t.Fatalf("Desktop argument producer: %v", err)
	}
	var cases [][]string
	if err = json.Unmarshal(output, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 6 {
		t.Fatalf("producer returned %d cases", len(cases))
	}
	for _, args := range cases {
		if err = validateRestartArguments(args); err != nil {
			t.Fatalf("Desktop produced %q: %v", args, err)
		}
	}
}
