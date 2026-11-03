package handoff

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const componentRedirects = 3

func componentURL(base, target string, c Component) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("component source must be HTTPS")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/v1/updates/components/" + target + "/" + c.Kind + "/" + c.Version + "/" + c.ArchiveSHA256
	return u.String(), nil
}

func componentClient() *http.Client {
	return &http.Client{Timeout: WorkerWait, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) > componentRedirects || request.URL.Scheme != "https" || request.URL.User != nil {
			return errors.New("component redirect must remain HTTPS and within limit")
		}
		return nil
	}}
}

// Existing receipt/archive authority and destination layout are shared with
// helper preparation; the launcher has no parallel trust or component store.
func (p Policy) downloadComponent(ctx context.Context, root, baseURL, target string, c Component, progress func(BootstrapProgress)) (err error) {
	timing := p.timer(c, timingDownload)
	defer timing.finish(&err)
	done := timing.start(timingPaths)
	archive, err := componentArchive(root, c)
	if err != nil {
		return err
	}
	if _, err = checkedPath(filepath.Dir(archive), filepath.Base(archive)+ArchiveTemporarySuffix); err != nil {
		return err
	}
	directory, err := componentDirectory(root, c)
	if err != nil {
		return err
	}
	stage := joinPath(root, "runtime/"+c.Kind+"/.prepare-0000000000")
	for _, base := range []string{directory, stage} {
		if _, err = checkedPath(base, ReceiptName); err != nil {
			return err
		}
		for _, member := range c.Files {
			if _, err = checkedPath(base, member.Path); err != nil {
				return err
			}
		}
	}
	done()
	if progress != nil {
		progress(BootstrapProgress{Phase: BootstrapChecking, Total: c.ArchiveBytes})
	}
	done = timing.start(timingReuse)
	reuse, err := checkReuse(p, root, c)
	done()
	if reuse {
		timing.event.Status = "reused"
	}
	if err != nil || reuse {
		return err
	}
	locks, err := ensureDirectories(root, ArchiveDirectory, false)
	if err != nil {
		return err
	}
	defer closeFiles(locks)
	if _, err = os.Lstat(archive); err == nil {
		if err = checkLineage(archive); err != nil {
			return err
		}
		file, openErr := pinFile(archive)
		if openErr != nil {
			return openErr
		}
		done = timing.start(timingArchive)
		archiveErr := checkArchive(file, c)
		done()
		file.Close()
		if archiveErr == nil {
			timing.event.Status = "retained"
			return nil
		}
		if err = os.Remove(archive); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = checkSpace(root, c.ArchiveBytes+c.ExpandedBytes); err != nil {
		return err
	}
	address, err := componentURL(baseURL, target, c)
	if err != nil {
		return err
	}
	return receiveComponent(ctx, componentClient(), address, archive, c, progress, timing)
}

func receiveComponent(ctx context.Context, client *http.Client, address, destination string, c Component, progress func(BootstrapProgress), timers ...*componentTimer) error {
	var timing *componentTimer
	if len(timers) > 0 {
		timing = timers[0]
	}
	done := timing.start(timingHeaders)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	done()
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("component download failed (%d)", response.StatusCode)
	}
	if response.ContentLength >= 0 && response.ContentLength != c.ArchiveBytes {
		return errors.New("component download length differs")
	}
	random := make([]byte, 6)
	if _, err = rand.Read(random); err != nil {
		return err
	}
	temporary := destination + ".part-" + hex.EncodeToString(random)
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { file.Close(); os.Remove(temporary) }()
	hash := sha256.New()
	reader := io.LimitReader(response.Body, c.ArchiveBytes+1)
	buffer := make([]byte, 128*1024)
	var received int64
	var reported time.Time
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		done = timing.start(timingRead)
		n, readErr := reader.Read(buffer)
		done()
		if n > 0 {
			received += int64(n)
			if received > c.ArchiveBytes {
				return errors.New("component download exceeds signed size")
			}
			done = timing.start(timingWrite)
			_, err = file.Write(buffer[:n])
			done()
			if err != nil {
				return err
			}
			done = timing.start(timingHash)
			_, _ = hash.Write(buffer[:n])
			done()
			if timing != nil {
				timing.event.Bytes += int64(n)
			}
			if progress != nil && time.Since(reported) >= 100*time.Millisecond {
				progress(BootstrapProgress{Phase: BootstrapDownloading, Received: received, Total: c.ArchiveBytes})
				reported = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if progress != nil {
		progress(BootstrapProgress{Phase: BootstrapVerifying, Received: received, Total: c.ArchiveBytes})
	}
	if received != c.ArchiveBytes || hex.EncodeToString(hash.Sum(nil)) != c.ArchiveSHA256 {
		return errors.New("component download digest differs")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	done = timing.start(timingSync)
	err = file.Sync()
	done()
	if err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	// Caller retains the archive-directory lineage and installation lock. Rename
	// publishes only authenticated bytes; Prepare subsequently pins and rechecks.
	done = timing.start(timingPublish)
	defer done()
	return os.Rename(temporary, destination)
}
