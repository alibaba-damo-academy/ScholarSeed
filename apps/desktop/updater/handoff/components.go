package handoff

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type Member struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type Component struct {
	Kind          string   `json:"kind"`
	Version       string   `json:"version"`
	ContentID     string   `json:"contentId"`
	Archive       string   `json:"archive"`
	ArchiveSHA256 string   `json:"archiveSha256"`
	ArchiveBytes  int64    `json:"archiveBytes"`
	ExpandedBytes int64    `json:"expandedBytes"`
	FileCount     int      `json:"fileCount"`
	Entry         string   `json:"entry"`
	Files         []Member `json:"files"`
}
type Runtime struct {
	Schema     int         `json:"schema"`
	Domain     string      `json:"domain"`
	ProductID  string      `json:"product_id"`
	BundleID   string      `json:"bundle_id"`
	AppID      string      `json:"app_id"`
	Target     string      `json:"target"`
	Components []Component `json:"components"`
}
type Receipt struct {
	Schema          int    `json:"schema"`
	ProductID       string `json:"product_id"`
	Kind            string `json:"kind"`
	Version         string `json:"version"`
	ContentID       string `json:"contentId"`
	ArchiveSHA256   string `json:"archiveSha256"`
	InventorySHA256 string `json:"inventorySha256"`
	AccessPolicy    int    `json:"accessPolicy,omitempty"`
	PrincipalSID    string `json:"principalSid,omitempty"`
	RootIdentity    string `json:"rootIdentity,omitempty"`
}
type ComponentResult struct {
	Kind      string `json:"kind"`
	Version   string `json:"version"`
	Directory string `json:"directory"`
	Reused    bool   `json:"reused"`
}

func joinPath(root, relative string) string { return filepath.Join(root, filepath.FromSlash(relative)) }

// Create one level at a time under a held parent. No MkdirAll call is allowed
// to follow a junction before its parent has been opened and inspected.
func ensureDirectories(root, relative string, held bool) ([]*os.File, error) {
	var locks []*os.File
	var err error
	if !held {
		locks, err = pinLineage(root)
		if err != nil {
			return nil, err
		}
	}
	if relative == "." || relative == "" {
		return locks, nil
	}
	if err = memberPath(filepath.ToSlash(relative)); err != nil {
		closeFiles(locks)
		return nil, err
	}
	current := root
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		current = filepath.Join(current, part)
		if err = os.Mkdir(current, 0755); err != nil && !os.IsExist(err) {
			closeFiles(locks)
			return nil, err
		}
		file, err := pinDirectory(current)
		if err != nil {
			closeFiles(locks)
			return nil, err
		}
		locks = append(locks, file)
	}
	return locks, nil
}
func fileHash(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func checkMembers(files []Member) (map[string]Member, int64, error) {
	if len(files) == 0 || len(files) > FileLimit {
		return nil, 0, errors.New("invalid file count")
	}
	result := make(map[string]Member, len(files))
	var total int64
	for _, m := range files {
		if err := memberPath(m.Path); err != nil {
			return nil, 0, err
		}
		key := strings.ToLower(m.Path)
		if _, ok := result[key]; ok || m.Size < 0 || m.Size > ExpandedLimit || !digestPattern.MatchString(m.SHA256) {
			return nil, 0, errors.New("invalid or duplicate member")
		}
		total += m.Size
		if total > ExpandedLimit {
			return nil, 0, errors.New("expanded size exceeds limit")
		}
		result[key] = m
	}
	for name := range result {
		parts := strings.Split(name, "/")
		for len(parts) > 1 {
			parts = parts[:len(parts)-1]
			if _, ok := result[strings.Join(parts, "/")]; ok {
				return nil, 0, errors.New("file/directory collision")
			}
		}
	}
	return result, total, nil
}
func (p Policy) ParseRuntime(raw []byte, baseline bool) (Runtime, error) {
	var r Runtime
	data, err := p.authenticate(raw, baseline)
	if err != nil {
		return r, err
	}
	if err = Decode(data, &r); err != nil {
		return r, err
	}
	if r.Schema != Schema || r.Domain != "scholarseed.runtime-components" || r.ProductID != p.ProductID || r.BundleID != p.BundleID || r.AppID != p.AppID || r.Target != p.Target || len(r.Components) < 1 || len(r.Components) > 32 {
		return r, errors.New("runtime identity differs")
	}
	kinds := map[string]bool{}
	archives := map[string]bool{}
	for _, c := range r.Components {
		if !kindPattern.MatchString(c.Kind) || memberPath(c.Kind) != nil || kinds[c.Kind] || !componentVersionPattern.MatchString(c.Version) || memberPath(c.Version) != nil || !digestPattern.MatchString(c.ContentID) || c.Archive != c.Kind+".zip" || !digestPattern.MatchString(c.ArchiveSHA256) || c.ArchiveBytes <= 0 || c.ArchiveBytes > PackageLimit || memberPath(c.Entry) != nil {
			return r, errors.New("invalid runtime component")
		}
		kinds[c.Kind] = true
		archive := c.Kind + "-" + c.Version + ".zip"
		if archives[archive] {
			return r, errors.New("component archive path collision")
		}
		archives[archive] = true
		members, total, err := checkMembers(c.Files)
		if err != nil {
			return r, err
		}
		if len(c.Files) != c.FileCount || total != c.ExpandedBytes {
			return r, errors.New("runtime inventory totals differ")
		}
		found := false
		for name := range members {
			if name == ReceiptName || strings.HasPrefix(name, ReceiptName+"/") {
				return r, errors.New("component inventory uses reserved receipt path")
			}
			if name == strings.ToLower(c.Entry) || strings.HasPrefix(name, strings.ToLower(c.Entry)+"/") {
				found = true
			}
		}
		if !found {
			return r, errors.New("component entry absent from inventory")
		}
	}
	return r, nil
}

func componentReceipt(p Policy, c Component) Receipt {
	raw, _ := json.Marshal(c.Files)
	receipt := Receipt{Schema: Schema, ProductID: p.ProductID, Kind: c.Kind, Version: c.Version, ContentID: c.ContentID, ArchiveSHA256: c.ArchiveSHA256, InventorySHA256: Hash(raw)}
	if p.admitsComponent(c.Kind) {
		receipt.AccessPolicy = toolAccessPolicy
		receipt.PrincipalSID = p.toolAdmission.principal
	}
	return receipt
}
func componentDirectory(root string, c Component) (string, error) {
	return checkedPath(root, "runtime/"+c.Kind+"/"+c.Version)
}

// Archives are downloaded by Electron before the helper starts. Their location is
// derived exclusively from the authenticated component identity, never a request URL
// or arbitrary caller path. Reusable components do not require archive files.
func componentArchive(root string, c Component) (string, error) {
	return checkedPath(root, ArchiveDirectory+"/"+c.Kind+"-"+c.Version+".zip")
}

// Both coordinator and worker keep these handles through authorization/commit.
// On Windows the pinned parent lineage and read-only sharing prevent replacement,
// truncation or redirection of an archive after verification.
func (p Policy) preflightComponents(result *prepared) (int64, error) {
	result.archives = make(map[string]*os.File)
	var requiredSpace int64
	for _, c := range result.runtime.Components {
		required, err := p.preflightComponent(result, c)
		if err != nil {
			return 0, err
		}
		requiredSpace += required
	}
	return requiredSpace, nil
}
func (p Policy) preflightComponent(result *prepared, c Component) (required int64, err error) {
	root := result.request.Root
	timing := p.timer(c, timingPreflight)
	defer timing.finish(&err)
	done := timing.start(timingPaths)
	dir, err := componentDirectory(root, c)
	if err != nil {
		return 0, err
	}
	archive, err := componentArchive(root, c)
	if err != nil {
		return 0, err
	}
	if _, err = checkedPath(filepath.Dir(archive), filepath.Base(archive)+ArchiveTemporarySuffix); err != nil {
		return 0, err
	}
	stage := joinPath(root, "runtime/"+c.Kind+"/.prepare-0000000000")
	for _, base := range []string{dir, stage} {
		if _, err = checkedPath(base, ReceiptName); err != nil {
			return 0, err
		}
	}
	for _, m := range c.Files {
		if _, err = checkedPath(dir, m.Path); err != nil {
			return 0, err
		}
		if _, err = checkedPath(stage, m.Path); err != nil {
			return 0, err
		}
	}
	done()
	done = timing.start(timingReuse)
	reuse, err := checkReuse(p, root, c, timing)
	done()
	if err != nil {
		return 0, err
	}
	if reuse {
		result.reused = append(result.reused, ComponentResult{c.Kind, c.Version, dir, true})
		timing.event.Status = "reused"
		return 0, nil
	}
	done = timing.start(timingArchive)
	defer done()
	parents, err := pinLineage(filepath.Dir(archive))
	if err != nil {
		return 0, err
	}
	result.locks = append(result.locks, parents...)
	if err = checkLineage(archive); err != nil {
		return 0, err
	}
	file, err := pinFile(archive)
	if err != nil {
		return 0, err
	}
	result.archives[c.Kind] = file
	if err = checkArchive(file, c); err != nil {
		return 0, err
	}
	return c.ExpandedBytes, nil
}

func checkArchive(file *os.File, c Component) error {
	st, err := file.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Size() != c.ArchiveBytes {
		return errors.New("component archive size differs")
	}
	sum, err := fileHash(file)
	if err != nil {
		return err
	}
	if sum != c.ArchiveSHA256 {
		return errors.New("component archive digest differs")
	}
	return nil
}

type reuseVerification uint8

const (
	verifyContent reuseVerification = iota
	publishedReadiness
)

func checkReadiness(p Policy, root string, c Component, timing *componentTimer) (bool, error) {
	return verifyReuse(p, root, c, publishedReadiness, timing)
}

func checkReuse(p Policy, root string, c Component, timers ...*componentTimer) (bool, error) {
	var timing *componentTimer
	if len(timers) > 0 {
		timing = timers[0]
	}
	return verifyReuse(p, root, c, verifyContent, timing)
}

func verifyReuse(p Policy, root string, c Component, verification reuseVerification, timing *componentTimer) (bool, error) {
	done := timing.start(timingLineage)
	defer func() { done() }()
	dir, err := componentDirectory(root, c)
	if err != nil {
		return false, err
	}
	if _, err = os.Lstat(dir); os.IsNotExist(err) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if err = checkLineage(dir); err != nil {
		return false, err
	}
	locks, err := pinLineage(dir)
	if err != nil {
		return false, err
	}
	defer closeFiles(locks)
	done()
	done = timing.start(timingReceipt)
	raw, err := readBounded(joinPath(dir, ReceiptName), 4096)
	if err != nil {
		return false, fmt.Errorf("existing component lacks valid receipt: %w", err)
	}
	var receipt Receipt
	if err = Decode(raw, &receipt); err != nil {
		return false, err
	}
	if p.admitsComponent(c.Kind) {
		identity, identityErr := toolRootIdentity(dir)
		if identityErr != nil {
			return false, identityErr
		}
		if receipt.RootIdentity == "" || receipt.RootIdentity != identity {
			return false, errors.New("component permission identity differs; repair installation")
		}
		receipt.RootIdentity = ""
	}
	done()
	done = timing.start(timingInventory)
	if receipt != componentReceipt(p, c) {
		return false, errors.New("component version collision")
	}
	done()
	done = timing.start(timingEntry)
	// Bounded entry verification avoids walking all Python files on every launch.
	var critical *Member
	for i := range c.Files {
		if strings.EqualFold(c.Files[i].Path, c.Entry) {
			critical = &c.Files[i]
			break
		}
		if critical == nil && strings.HasPrefix(strings.ToLower(c.Files[i].Path), strings.ToLower(c.Entry)+"/") {
			critical = &c.Files[i]
		}
	}
	if critical == nil {
		return false, errors.New("missing critical entry")
	}
	filename, err := checkedPath(dir, critical.Path)
	if err != nil {
		return false, err
	}
	if err = checkLineage(filename); err != nil {
		return false, err
	}
	entryLocks, err := pinLineage(filepath.Dir(filename))
	if err != nil {
		return false, err
	}
	defer closeFiles(entryLocks)
	f, err := pinFile(filename)
	if err != nil {
		return false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false, err
	}
	if !st.Mode().IsRegular() || st.Size() != critical.Size {
		return false, errors.New("component critical entry changed")
	}
	// Publication receipts attest installation validation, not subsequent content
	// integrity. Normal startup checks identity and availability without reading
	// payload bytes; installation/update/repair retain full hashing below.
	if verification == publishedReadiness {
		return true, nil
	}
	done()
	done = timing.start(timingHash)
	sum, err := fileHash(f)
	if timing != nil {
		timing.event.Bytes += st.Size()
	}
	if err != nil {
		return false, err
	}
	if st.Size() != critical.Size || sum != critical.SHA256 {
		return false, errors.New("component critical entry changed")
	}
	return true, nil
}

func readBounded(filename string, limit int64) ([]byte, error) {
	locks, err := pinLineage(filepath.Dir(filename))
	if err != nil {
		return nil, err
	}
	defer closeFiles(locks)
	f, err := pinFile(filename)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() < 1 || st.Size() > limit {
		return nil, errors.New("file exceeds bounded input")
	}
	return io.ReadAll(io.LimitReader(f, limit+1))
}

func verifyArchive(z *zip.Reader, files []Member, destination string, extract bool, timers ...*componentTimer) error {
	var timing *componentTimer
	if len(timers) > 0 {
		timing = timers[0]
	}
	return verifyArchiveWithFlush(z, files, destination, extract, componentFlushWorkers, timing)
}

func verifyArchiveWithFlush(z *zip.Reader, files []Member, destination string, extract bool, workers int, timing *componentTimer, progress ...func(int, int64)) (err error) {
	var flush *extractionFlush
	parents := &extractionDirectories{root: destination}
	if extract {
		flush = newExtractionFlush(workers, timing)
		defer func() { err = errors.Join(err, flush.finish(), parents.Close()) }()
	}
	expected, _, err := checkMembers(files)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	var completedBytes int64
	directories := map[string]bool{}
	for _, f := range z.File {
		done := timing.start(timingPaths)
		name := strings.TrimSuffix(f.Name, "/")
		if err = memberPath(name); err != nil {
			return err
		}
		if _, err = checkedPath(destination, name); err != nil {
			return err
		}
		key := strings.ToLower(name)
		if seen[key] || directories[key] {
			return errors.New("duplicate archive member")
		}
		if f.Mode()&os.ModeSymlink != 0 || f.Mode()&(os.ModeDevice|os.ModeNamedPipe|os.ModeSocket) != 0 || f.ExternalAttrs&0x400 != 0 {
			return errors.New("special archive member")
		}
		if f.FileInfo().IsDir() {
			if _, ok := expected[key]; ok {
				return errors.New("archive directory replaces file")
			}
			directories[key] = true
			done()
			continue
		}
		m, ok := expected[key]
		if !ok || m.Path != name || f.UncompressedSize64 != uint64(m.Size) {
			return errors.New("archive inventory differs")
		}
		seen[key] = true
		done()
		done = timing.start(timingRead)
		reader, err := f.Open()
		done()
		if err != nil {
			return err
		}
		// Component extraction follows checkArchive on a pinned ZIP. Release
		// verification (including reconstructed deltas) still needs member hashes.
		var h hash.Hash
		var writer io.Writer
		if !extract {
			h = sha256.New()
			writer = timedWriter{h, timing, timingHash}
		}
		var out *os.File
		var directory *directoryPin
		if extract {
			filename := joinPath(destination, name)
			done = timing.start(timingDirectories)
			directory, err = parents.acquire(filepath.Dir(filepath.FromSlash(name)), timing)
			if err == nil {
				created := timing.start(timingFileCreate)
				out, err = os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
				created()
			}
			done()
			if err != nil {
				err = errors.Join(err, directory.Close())
				reader.Close()
				return err
			}
			writer = timedWriter{out, timing, timingWrite}
		}
		done = timing.start(timingCopy)
		n, copyErr := io.Copy(writer, io.LimitReader(timedReader{reader, timing}, m.Size+1))
		done()
		if timing != nil {
			timing.event.Files++
			timing.event.Bytes += n
		}
		done = timing.start(timingClose)
		closeErr := reader.Close()
		done()
		if copyErr == nil && closeErr == nil && n != m.Size {
			copyErr = errors.New("archive member size differs")
		}
		if copyErr == nil && closeErr == nil && h != nil && hex.EncodeToString(h.Sum(nil)) != m.SHA256 {
			copyErr = errors.New("archive member digest differs")
		}
		if copyErr != nil || closeErr != nil {
			if out != nil {
				copyErr = errors.Join(copyErr, (flushJob{out, directory}).close())
			}
			return errors.Join(copyErr, closeErr)
		}
		if out != nil {
			if err = flush.submit(flushJob{out, directory}); err != nil {
				return err
			}
		}
		completedBytes += n
		if len(progress) > 0 {
			progress[0](len(seen), completedBytes)
		}
	}
	if len(seen) != len(expected) {
		return errors.New("archive missing inventory members")
	}
	return nil
}

// Prepare never changes an already published component. Missing components are
// built below the installation root so ACL inheritance and rename volume agree.
func (p Policy) Prepare(root string, r Runtime, archive func(Component) (*os.File, error)) ([]ComponentResult, error) {
	var results []ComponentResult
	for _, c := range r.Components {
		result, err := p.prepareComponent(root, c, archive)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}
func (p Policy) prepareComponent(root string, c Component, archive func(Component) (*os.File, error)) (ComponentResult, error) {
	return p.prepareComponentWithFlush(root, c, archive, componentFlushWorkers)
}

func (p Policy) prepareComponentWithFlush(root string, c Component, archive func(Component) (*os.File, error), workers int) (result ComponentResult, err error) {
	timing := p.timer(c, timingPrepare)
	report := p.componentProgress(c)
	report("checking", 0, 0)
	defer timing.finish(&err)
	dir, err := componentDirectory(root, c)
	if err != nil {
		return ComponentResult{}, err
	}
	done := timing.start(timingReuse)
	reuse, err := checkReuse(p, root, c, timing)
	done()
	if err != nil {
		return ComponentResult{}, err
	}
	if reuse {
		timing.event.Status = "reused"
		report("reused", len(c.Files), c.ExpandedBytes)
		return ComponentResult{c.Kind, c.Version, dir, true}, nil
	}
	parent := filepath.Dir(dir)
	done = timing.start(timingDirectories)
	parentLocks, err := ensureDirectories(root, "runtime/"+c.Kind, false)
	done()
	if err != nil {
		return ComponentResult{}, err
	}
	f, err := archive(c)
	if err != nil {
		closeFiles(parentLocks)
		return ComponentResult{}, err
	}
	err = func() error {
		defer closeFiles(parentLocks)
		defer f.Close()
		done = timing.start(timingArchive)
		err = checkArchive(f, c)
		done()
		if err != nil {
			return err
		}
		if err = checkSpace(root, c.ExpandedBytes); err != nil {
			return err
		}
		z, err := zip.NewReader(f, c.ArchiveBytes)
		if err != nil {
			return err
		}
		stage, err := os.MkdirTemp(parent, ".prepare-")
		if err != nil {
			return err
		}
		stageHandle, err := holdStage(stage)
		if err != nil {
			os.RemoveAll(stage)
			return err
		}
		defer func() { stageHandle.Close(); os.RemoveAll(stage) }()
		if p.admitsComponent(c.Kind) {
			done = timing.start(timingPermissions)
			err = p.toolAdmission.prepare(stageHandle)
			done()
			if err != nil {
				return err
			}
		}
		// Every path is checked before writing the first archive member.
		done = timing.start(timingPaths)
		for _, m := range c.Files {
			if _, err = checkedPath(stage, m.Path); err != nil {
				return err
			}
			if _, err = checkedPath(dir, m.Path); err != nil {
				return err
			}
		}
		done()
		done = timing.start(timingExtract)
		report("extracting", 0, 0)
		err = verifyArchiveWithFlush(z, c.Files, stage, true, workers, timing, func(files int, bytes int64) { report("extracting", files, bytes) })
		done()
		if err != nil {
			return err
		}
		report("publishing", len(c.Files), c.ExpandedBytes)
		done = timing.start(timingPublish)
		defer done()
		receipt := componentReceipt(p, c)
		if p.admitsComponent(c.Kind) {
			receipt.RootIdentity, err = toolStageIdentity(stageHandle)
			if err != nil {
				return err
			}
		}
		raw, _ := json.Marshal(receipt)
		if err = writeReceipt(joinPath(stage, ReceiptName), raw); err != nil {
			return err
		}
		return publishStage(stageHandle, stage, dir)
	}()
	if err != nil {
		return ComponentResult{}, err
	}
	report("complete", len(c.Files), c.ExpandedBytes)
	return ComponentResult{c.Kind, c.Version, dir, false}, nil
}
