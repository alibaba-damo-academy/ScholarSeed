package handoff

import (
	"errors"
	"os"
	"path/filepath"
)

const RuntimeStoreDirectory = "runtime"

func PinRuntimeStore(root string) (func(), bool, error) {
	pins, err := pinLineage(root)
	if err != nil {
		return nil, false, err
	}
	store := filepath.Join(root, RuntimeStoreDirectory)
	if _, err = os.Lstat(store); errors.Is(err, os.ErrNotExist) {
		return func() { closeFiles(pins) }, false, nil
	} else if err != nil {
		closeFiles(pins)
		return nil, false, err
	}
	storePins, err := pinLineage(store)
	if err != nil {
		closeFiles(pins)
		return nil, false, err
	}
	return func() { closeFiles(storePins); closeFiles(pins) }, true, nil
}
