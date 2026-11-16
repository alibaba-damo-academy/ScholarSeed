package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInaccessiblePackagedEngineBlocksReplacement(t *testing.T) {
	if !setupRelevantImage("ScholarSeedEngine.exe") {
		t.Fatal("an inaccessible packaged engine must block replacement")
	}
	if !setupRelevantImage("PYTHON.EXE") || setupRelevantImage("unrelated.exe") {
		t.Fatal("runtime classification lost its image-name boundary")
	}
}

func TestInstallationOccupancyUsesNativeImagePath(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	active, err := installationActive(filepath.Dir(executable))
	if err != nil || !active {
		t.Fatalf("own executable was not observed: %v %v", active, err)
	}
	active, err = installationActive(t.TempDir())
	if err != nil || active {
		t.Fatalf("unrelated empty installation was occupied: %v %v", active, err)
	}
}
func TestSystemProcessImageMatchesHandleQuery(t *testing.T) {
	pid := uint32(os.Getpid())
	direct, err := setupProcessImage(pid, setupProcessNameNative)
	if err != nil {
		t.Fatal(err)
	}
	system, err := setupSystemProcessImage(pid)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(system, direct) {
		t.Fatalf("system image %q differs from handle image %q", system, direct)
	}
}

func TestMissingSetupEndpointPreservesLegacyFallback(t *testing.T) {
	supported, err := requestInstallationExit(t.TempDir())
	if err != nil || supported {
		t.Fatalf("%v %v", supported, err)
	}
}
