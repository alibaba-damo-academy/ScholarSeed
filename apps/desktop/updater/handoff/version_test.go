package handoff

import "testing"

func TestComparePackVersionsPreservesUpdateAdmission(t *testing.T) {
	const current = "0.3.2-build.202611091617"
	for _, tc := range []struct {
		candidate  string
		comparison int
	}{
		{current, 0}, {"0.3.3-build.202611080000", 1}, {"0.3.2-build.202611091618", 1},
		{"0.3.1-build.202611101617", -1}, {"0.3.2-build.202611091616", -1},
	} {
		comparison, err := ComparePackVersions(tc.candidate, current)
		if err != nil || comparison != tc.comparison {
			t.Fatalf("%s: %d %v", tc.candidate, comparison, err)
		}
		if (newer(tc.candidate, current) == nil) != (comparison > 0) {
			t.Fatal("online update admitted non-newer package")
		}
	}
	for _, invalid := range []string{"", "0.3.2", "x.3.2-build.202611091617", "18446744073709551616.3.2-build.202611091617"} {
		if _, err := ComparePackVersions(invalid, current); err == nil {
			t.Fatal("invalid candidate accepted")
		}
		if _, err := ComparePackVersions(current, invalid); err == nil {
			t.Fatal("invalid installed version accepted")
		}
	}
}
