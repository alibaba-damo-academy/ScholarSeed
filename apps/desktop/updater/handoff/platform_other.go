//go:build !windows

package handoff

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

var errWindows = errors.New("handoff execution requires Windows")

const componentFlushWorkers = 0

func pinDirectory(filename string) (*os.File, error) {
	if err := checkLineage(filename); err != nil {
		return nil, err
	}
	return os.Open(filename)
}
func pinExtractionDirectory(filename string) (*os.File, error) { return pinDirectory(filename) }
func holdStage(filename string) (*os.File, error)              { return pinDirectory(filename) }
func publishStage(_ *os.File, from, to string) error           { return os.Rename(from, to) }
func verifyAuthenticodeFiles([]string, Signing) error          { return errWindows }
func verifyAuthenticode(string, Signing) error                 { return errWindows }
func openProcessWaiter(uint32) (processWaiter, error)          { return nil, errWindows }
func newUpdateJob(string) (updateJob, error)                   { return nil, errWindows }
func openUpdaterJob(string) (updaterInvocation, error)         { return nil, errWindows }
func openChannel(filename string, write bool) (*os.File, error) {
	mode := os.O_RDONLY
	if write {
		mode = os.O_RDWR
	}
	return os.OpenFile(filename, mode, 0600)
}

func pinLineage(filename string) ([]*os.File, error) {
	if err := checkLineage(filename); err != nil {
		return nil, err
	}
	return nil, nil
}

func checkLineage(filename string) error {
	for current := filepath.Clean(filename); ; current = filepath.Dir(current) {
		st, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return errors.New("symlink rejected")
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return nil
}
func pinFile(filename string) (*os.File, error)                 { return os.Open(filename) }
func checkSpace(string, int64) error                            { return nil }
func rootWritable(string) bool                                  { return false }
func installationLock(string) (func(), error)                   { return nil, errWindows }
func hideProcess(*exec.Cmd)                                     {}
func restart(string, []string) (int, error)                     { return 0, errWindows }
func refreshApplicationIcons(string) error                      { return errWindows }
func startWorker(string, []string, bool) (workerProcess, error) { return nil, errWindows }
func grantAdministrators(string, bool) error                    { return errWindows }
