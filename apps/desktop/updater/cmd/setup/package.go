package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const setupUpdaterMember = "lib/app/Squirrel.exe"

// These bounds and digests come from the build's inspected full package, which
// is already embedded in the official Setup. Setup's signature covers them.
type replacementPackage struct {
	Offset        int    `json:"offset"`
	Size          int    `json:"size"`
	SHA256        string `json:"sha256"`
	UpdaterSize   int64  `json:"updaterSize"`
	UpdaterSHA256 string `json:"updaterSha256"`
}

func checkedPackage(data []byte, p replacementPackage) ([]byte, error) {
	if p.Offset < 0 || p.Size <= 0 || p.Offset > len(data) || p.Size > len(data)-p.Offset || p.UpdaterSize <= 0 {
		return nil, errors.New("invalid embedded replacement package bounds")
	}
	contents := data[p.Offset : p.Offset+p.Size]
	digest := sha256.Sum256(contents)
	if hex.EncodeToString(digest[:]) != p.SHA256 {
		return nil, errors.New("embedded replacement package changed")
	}
	return contents, nil
}

// Only the fixed updater member is extracted. All other application members
// remain in the authenticated full package for the official engine to apply.
func preparePackage(directory string, data []byte, p replacementPackage) (string, string, func(), error) {
	contents, err := checkedPackage(data, p)
	if err != nil {
		return "", "", nil, err
	}
	reader, err := zip.NewReader(bytes.NewReader(contents), int64(len(contents)))
	if err != nil {
		return "", "", nil, err
	}
	var updater *zip.File
	for _, entry := range reader.File {
		if entry.Name == setupUpdaterMember {
			if updater != nil || entry.UncompressedSize64 != uint64(p.UpdaterSize) || !entry.Mode().IsRegular() {
				return "", "", nil, errors.New("invalid official updater member")
			}
			updater = entry
		}
	}
	if updater == nil {
		return "", "", nil, errors.New("official updater member missing")
	}
	stream, err := updater.Open()
	if err != nil {
		return "", "", nil, err
	}
	defer stream.Close()
	raw, err := io.ReadAll(io.LimitReader(stream, p.UpdaterSize+1))
	if err != nil {
		return "", "", nil, err
	}
	digest := sha256.Sum256(raw)
	if int64(len(raw)) != p.UpdaterSize || hex.EncodeToString(digest[:]) != p.UpdaterSHA256 {
		return "", "", nil, errors.New("official updater content changed")
	}
	packagePath := filepath.Join(directory, "replacement-full.nupkg")
	updaterPath := filepath.Join(directory, "Update.exe")
	var held []*os.File
	release := func() {
		for _, file := range held {
			_ = file.Close()
		}
	}
	for _, item := range []struct {
		path string
		data []byte
	}{{packagePath, contents}, {updaterPath, raw}} {
		file, err := os.OpenFile(item.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			_, err = file.Write(item.data)
			err = errors.Join(err, file.Close())
		}
		if err != nil {
			release()
			return "", "", nil, err
		}
		file, err = holdPayload(item.path)
		if err == nil {
			held = append(held, file)
			var actual []byte
			actual, err = io.ReadAll(file)
			if err == nil && !bytes.Equal(actual, item.data) {
				err = errors.New("replacement input changed after writing")
			}
		}
		if err != nil {
			release()
			return "", "", nil, err
		}
	}
	return packagePath, updaterPath, release, nil
}

func replacementArguments(root, packagePath string) []string {
	return []string{"apply", "--rootDir", root, "--packageDir", filepath.Join(root, "packages"), "--package", packagePath, "--norestart"}
}
