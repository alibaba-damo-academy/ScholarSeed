package handoff

import (
	"os"
	"testing"
)

func TestIconRefreshRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{"ScholarSeed.exe", `\\server\share\ScholarSeed.exe`, "C:\\app\x00.exe"} {
		t.Run(path, func(t *testing.T) {
			if err := refreshApplicationIcons(path); err == nil {
				t.Fatal("unsafe icon path accepted")
			}
		})
	}
}

func TestIconRefreshNative(t *testing.T) {
	// This deliberately notifies the interactive Shell. Ordinary test runs must
	// not disturb a user's desktop. This is an API probe, not update acceptance.
	if os.Getenv("SCHOLARSEED_TEST_ICON_REFRESH") != "1" {
		t.Skip("native Shell notification requires explicit probe authorization")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = refreshApplicationIcons(executable); err != nil {
		t.Fatal(err)
	}
}
