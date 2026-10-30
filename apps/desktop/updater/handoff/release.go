package handoff

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var packVersionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)-build\.(\d{12})$`)

type Release struct {
	Schema      int      `json:"schema"`
	Domain      string   `json:"domain"`
	ProductID   string   `json:"product_id"`
	BundleID    string   `json:"bundle_id"`
	AppID       string   `json:"app_id"`
	Arch        string   `json:"arch_type"`
	Channel     string   `json:"channel"`
	PackVersion string   `json:"pack_version"`
	Files       []Member `json:"files"`
}

func versionNumbers(value string) ([4]uint64, error) {
	var numbers [4]uint64
	m := packVersionPattern.FindStringSubmatch(value)
	if m == nil {
		return numbers, errors.New("invalid package version")
	}
	for i := range numbers {
		n, err := strconv.ParseUint(m[i+1], 10, 64)
		if err != nil {
			return numbers, err
		}
		numbers[i] = n
	}
	return numbers, nil
}
func newer(candidate, current string) error {
	a, err := versionNumbers(candidate)
	if err != nil {
		return err
	}
	b, err := versionNumbers(current)
	if err != nil {
		return err
	}
	for i := range a {
		if a[i] > b[i] {
			return nil
		}
		if a[i] < b[i] {
			return errors.New("package downgrade rejected")
		}
	}
	return errors.New("package already installed")
}
func installedVersion(root string) (string, error) {
	raw, err := readBounded(joinPath(root, "current/sq.version"), 1024*1024)
	if err != nil {
		return "", err
	}
	var packageXML struct {
		Metadata struct {
			ID      string `xml:"id"`
			Version string `xml:"version"`
		} `xml:"metadata"`
	}
	if err = xml.Unmarshal(raw, &packageXML); err != nil {
		return "", err
	}
	if packageXML.Metadata.ID != "scholarseed" {
		return "", errors.New("installation package identity differs")
	}
	if _, err = versionNumbers(packageXML.Metadata.Version); err != nil {
		return "", err
	}
	return packageXML.Metadata.Version, nil
}

func (p Policy) verifyRelease(envelope []byte, f *os.File, root string) (*zip.Reader, Release, error) {
	var r Release
	raw, err := p.authenticate(envelope, false)
	if err != nil {
		return nil, r, err
	}
	if err = Decode(raw, &r); err != nil {
		return nil, r, err
	}
	if r.Schema != Schema || r.Domain != "scholarseed.velopack-release" || r.ProductID != p.ProductID || r.BundleID != p.BundleID || r.AppID != p.AppID || r.Channel != p.Channel || r.Arch != "windows-amd64" {
		return nil, r, errors.New("release identity differs")
	}
	current, err := installedVersion(root)
	if err != nil {
		return nil, r, err
	}
	if err = newer(r.PackVersion, current); err != nil {
		return nil, r, err
	}
	if err = newer(r.PackVersion, p.PackVersion); err != nil {
		return nil, r, err
	}
	st, err := f.Stat()
	if err != nil {
		return nil, r, err
	}
	if st.Size() < 1 || st.Size() > PackageLimit {
		return nil, r, errors.New("package exceeds limit")
	}
	z, err := zip.NewReader(f, st.Size())
	if err != nil {
		return nil, r, err
	}
	// A reconstructed delta ZIP need not equal the original full ZIP bytes. Its
	// complete signed member inventory is the compression-independent authority.
	if err = verifyArchive(z, r.Files, root, false); err != nil {
		return nil, r, err
	}
	for _, m := range r.Files {
		if strings.HasPrefix(strings.ToLower(m.Path), "lib/") && !strings.HasPrefix(m.Path, "lib/app/") {
			return nil, r, errors.New("unsupported application prefix")
		}
		if strings.HasPrefix(m.Path, "lib/app/") {
			relative := strings.TrimPrefix(m.Path, "lib/app/")
			for _, base := range []string{joinPath(root, "current"), joinPath(root, "packages/VelopackTemp/tmp_0000000000000000")} {
				if _, err = checkedPath(base, relative); err != nil {
					return nil, r, err
				}
			}
		}
	}
	return z, r, nil
}
func zipMember(z *zip.Reader, name string) (*zip.File, error) {
	for _, f := range z.File {
		if f.Name == name {
			return f, nil
		}
	}
	return nil, fmt.Errorf("missing package member %s", name)
}
func zipBytes(z *zip.Reader, name string, limit int64) ([]byte, error) {
	f, err := zipMember(z, name)
	if err != nil {
		return nil, err
	}
	if f.UncompressedSize64 > uint64(limit) {
		return nil, errors.New("package metadata exceeds limit")
	}
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, limit+1))
}
