package handoff

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
)

// A pin owns one reference to its parent. The producer and outstanding flush
// jobs share references to leaves; every ancestor stays pinned until the last
// dependent file closes. Windows pins deny deletion and reject reparse points.
type directoryPin struct {
	file     *os.File
	parent   *directoryPin
	relative string
	refs     atomic.Int32
}

func (p *directoryPin) retain() *directoryPin {
	if p != nil {
		p.refs.Add(1)
	}
	return p
}

func (p *directoryPin) Close() error {
	if p == nil || p.refs.Add(-1) != 0 {
		return nil
	}
	return errors.Join(p.file.Close(), p.parent.Close())
}

// Keep only the current lineage, not a growing cache of all archive directories.
// Old branches live only while bounded flush jobs still reference them. The
// caller holds the staging root throughout extraction, draining and publication.
type extractionDirectories struct {
	root    string
	current *directoryPin
}

func (d *extractionDirectories) Close() error {
	current := d.current
	d.current = nil
	return current.Close()
}

func (d *extractionDirectories) acquire(relative string, timing *componentTimer) (*directoryPin, error) {
	relative = filepath.ToSlash(relative)
	if relative == "." || relative == "" {
		return nil, nil
	}
	if err := memberPath(relative); err != nil {
		return nil, err
	}
	prefix := d.current
	for prefix != nil && relative != prefix.relative && !strings.HasPrefix(relative, prefix.relative+"/") {
		prefix = prefix.parent
	}
	current := prefix.retain()
	remaining := relative
	if current != nil {
		remaining = strings.TrimPrefix(strings.TrimPrefix(relative, current.relative), "/")
	}
	if remaining != "" {
		for _, part := range strings.Split(remaining, "/") {
			name := part
			if current != nil {
				name = current.relative + "/" + part
			}
			path := joinPath(d.root, name)
			done := timing.start(timingDirectoryPin)
			err := os.Mkdir(path, 0755)
			var file *os.File
			if err == nil || os.IsExist(err) {
				file, err = pinExtractionDirectory(path)
			}
			done()
			if err != nil {
				return nil, errors.Join(err, current.Close())
			}
			// Transfer the local parent's reference to the new child.
			current = &directoryPin{file: file, parent: current, relative: name}
			current.refs.Store(1)
		}
	}
	previous := d.current
	d.current = current
	if err := previous.Close(); err != nil {
		return nil, err
	}
	return current.retain(), nil
}
