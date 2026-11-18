package handoff

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const cacheSweepBudget = 2 * time.Second
const cacheSweepEntries = 256
const cacheSweepRemovals = 8
const archiveRetention = 30 * 24 * time.Hour
const stagingRetention = 24 * time.Hour

var verifiedStageName = regexp.MustCompile(`^verified-[A-Za-z0-9]{6}$`)
var componentStageName = regexp.MustCompile(`^\.prepare-[0-9]{1,10}$`)

// The caller owns the installation lock used by component extraction and apply.
// Delete-sharing pins also exclude a live Desktop download in another process.
func sweepUpdateCache(ctx context.Context, root, product string, installed, target Runtime) {
	ctx, cancel := context.WithTimeout(ctx, cacheSweepBudget)
	defer cancel()
	now := time.Now()
	keep := make(map[string]bool)
	kinds := make(map[string]bool)
	for _, runtime := range []Runtime{installed, target} {
		for _, c := range runtime.Components {
			kinds[c.Kind] = true
			keep[c.Kind+"-"+c.Version+".zip"] = true
		}
	}
	remaining := cacheSweepRemovals
	sweep := func(directory string, archive bool, cutoff time.Time, matches func(string) bool) {
		if ctx.Err() != nil || remaining == 0 {
			return
		}
		locks, err := pinLineage(directory)
		if err != nil {
			return
		}
		defer closeFiles(locks)
		listing, err := os.Open(directory)
		if err != nil {
			return
		}
		defer listing.Close()
		for ctx.Err() == nil && remaining > 0 {
			entries, readErr := listing.ReadDir(cacheSweepEntries)
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				return
			}
			for _, entry := range entries {
				if ctx.Err() != nil || remaining == 0 {
					return
				}
				if entry.IsDir() == archive {
					continue
				}
				info, err := entry.Info()
				if err != nil || !info.ModTime().Before(cutoff) || !matches(entry.Name()) {
					continue
				}
				if _, err := cleanQualifiedTree(ctx, filepath.Join(directory, entry.Name()), archive, cutoff); err != nil {
					fmt.Fprintln(os.Stderr, "[update] cache entry retained:", err)
				} else {
					remaining--
				}
			}
			if readErr != nil {
				return
			}
		}
	}
	sweep(filepath.Join(root, "packages"), false, now.Add(-stagingRetention), verifiedStageName.MatchString)
	for kind := range kinds {
		sweep(joinPath(root, RuntimeStoreDirectory+"/"+kind), false, now.Add(-stagingRetention), componentStageName.MatchString)
	}
	// An unreadable installed manifest leaves archive ownership uncertain.
	if len(installed.Components) == 0 {
		return
	}
	sweep(joinPath(root, ArchiveDirectory), true, now.Add(-archiveRetention), func(name string) bool {
		if keep[name] || !strings.HasSuffix(name, ".zip") {
			return false
		}
		for kind := range kinds {
			if version, matched := strings.CutPrefix(strings.TrimSuffix(name, ".zip"), kind+"-"); matched &&
				componentVersionPattern.MatchString(version) {
				// A previous publication receipt proves this cache name belongs to
				// this installation. A matching filename alone gives no authority.
				filename := joinPath(root, RuntimeStoreDirectory+"/"+kind+"/"+version+"/"+ReceiptName)
				raw, err := readBounded(filename, 4096)
				var receipt Receipt
				if err == nil && json.Unmarshal(raw, &receipt) == nil &&
					receipt.Schema == Schema && receipt.ProductID == product &&
					receipt.Kind == kind && receipt.Version == version &&
					digestPattern.MatchString(receipt.ArchiveSHA256) {
					return true
				}
			}
		}
		return false
	})
}
