package handoff

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testPolicy() Policy {
	return Policy{Schema: 1, ProductID: "scholarseed", BundleID: "scholarseed", AppID: "scholarseed", Target: "win32-x86_64", Channel: "preview", PackVersion: "0.2.0-build.202610170001", Executable: "ScholarSeed.exe", Keys: map[string]string{}}
}
func fixture(t *testing.T) (Policy, Runtime, map[string][]byte) {
	t.Helper()
	p := testPolicy()
	r := Runtime{Schema: 1, Domain: "scholarseed.runtime-components", ProductID: p.ProductID, BundleID: p.BundleID, AppID: p.AppID, Target: p.Target}
	archives := map[string][]byte{}
	for _, kind := range []string{"python", "texlive", "powershell", "codex", "office"} {
		data := []byte("verified " + kind)
		entry := kind + "/entry.exe"
		var buffer bytes.Buffer
		z := zip.NewWriter(&buffer)
		f, err := z.Create(entry)
		if err != nil {
			t.Fatal(err)
		}
		f.Write(data)
		if err = z.Close(); err != nil {
			t.Fatal(err)
		}
		archive := buffer.Bytes()
		archives[kind] = archive
		r.Components = append(r.Components, Component{Kind: kind, Version: "1.0-r1", ContentID: Hash([]byte(kind)), Archive: kind + ".zip", ArchiveSHA256: Hash(archive), ArchiveBytes: int64(len(archive)), ExpandedBytes: int64(len(data)), FileCount: 1, Entry: entry, Files: []Member{{Path: entry, Size: int64(len(data)), SHA256: Hash(data)}}})
	}
	raw, _ := json.Marshal(r)
	p.RuntimeSHA256 = Hash(raw)
	return p, r, archives
}
func TestInitialRuntimeRequiresExactFrozenBytes(t *testing.T) {
	p, r, _ := fixture(t)
	raw, _ := json.Marshal(r)
	if _, err := p.ParseRuntime(raw, true); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ParseRuntime(append(raw, '\n'), true); err == nil {
		t.Fatal("accepted other initial bytes")
	}
	if _, err := p.ParseRuntime(raw, false); err == nil {
		t.Fatal("accepted unsigned update")
	}
}
func TestSignedRuntimeRequiresPinnedKeyAndIdentity(t *testing.T) {
	p, r, _ := fixture(t)
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	p.Keys["ci"] = base64.StdEncoding.EncodeToString(public)
	raw, _ := json.Marshal(r)
	envelope, _ := json.Marshal(Envelope{Schema: 1, KeyID: "ci", Manifest: base64.StdEncoding.EncodeToString(raw), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw))})
	if _, err := p.ParseRuntime(envelope, false); err != nil {
		t.Fatal(err)
	}
	p.BundleID = "other"
	if _, err := p.ParseRuntime(envelope, false); err == nil {
		t.Fatal("accepted different bundle")
	}
}
func TestPrepareReusesFilesAndRejectsCollision(t *testing.T) {
	p, r, archives := fixture(t)
	root := t.TempDir()
	archiveDirectory := t.TempDir()
	for kind, data := range archives {
		if err := os.WriteFile(filepath.Join(archiveDirectory, kind+".zip"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	opens := 0
	open := func(c Component) (*os.File, error) {
		opens++
		return os.Open(filepath.Join(archiveDirectory, c.Archive))
	}
	first, err := p.Prepare(root, r, open)
	if err != nil {
		t.Fatal(err)
	}
	if opens != 5 {
		t.Fatal(opens)
	}
	stat, err := os.Stat(filepath.Join(first[0].Directory, filepath.FromSlash(r.Components[0].Entry)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := p.Prepare(root, r, open)
	if err != nil {
		t.Fatal(err)
	}
	if opens != 5 {
		t.Fatal("reuse reopened component archives")
	}
	for _, item := range second {
		if !item.Reused {
			t.Fatal("component not reused")
		}
	}
	after, _ := os.Stat(filepath.Join(first[0].Directory, filepath.FromSlash(r.Components[0].Entry)))
	if !stat.ModTime().Equal(after.ModTime()) || !os.SameFile(stat, after) {
		t.Fatal("reuse replaced runtime file")
	}
	r.Components[0].ContentID = Hash([]byte("changed"))
	if _, err = p.Prepare(root, r, open); err == nil {
		t.Fatal("accepted readable version collision")
	}
}
func TestChangedCriticalEntryFailsWithoutOverwriting(t *testing.T) {
	p, r, archives := fixture(t)
	root := t.TempDir()
	open := func(c Component) (*os.File, error) {
		f, err := os.CreateTemp(t.TempDir(), "archive")
		if err != nil {
			return nil, err
		}
		_, err = f.Write(archives[c.Kind])
		return f, err
	}
	if _, err := p.Prepare(root, r, open); err != nil {
		t.Fatal(err)
	}
	dir, _ := componentDirectory(root, r.Components[0])
	filename := joinPath(dir, r.Components[0].Entry)
	os.WriteFile(filename, []byte("bad"), 0600)
	if _, err := p.Prepare(root, r, open); err == nil {
		t.Fatal("changed entry reused")
	}
	raw, _ := os.ReadFile(filename)
	if string(raw) != "bad" {
		t.Fatal("silently overwrote existing component")
	}
}
func TestArchiveRejectsTraversalExtraAndMissing(t *testing.T) {
	for _, name := range []string{"../escape", "safe/extra.exe", "CON.txt"} {
		t.Run(name, func(t *testing.T) {
			var buffer bytes.Buffer
			z := zip.NewWriter(&buffer)
			f, _ := z.Create(name)
			f.Write([]byte("data"))
			z.Close()
			reader, _ := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
			if err := verifyArchive(reader, []Member{{Path: "safe/entry.exe", Size: 4, SHA256: Hash([]byte("data"))}}, t.TempDir(), true); err == nil {
				t.Fatal("accepted invalid archive")
			}
		})
	}
}
func TestPathBudgetAndWindowsNames(t *testing.T) {
	for _, name := range []string{"a/../b", "a\\b", "a:", "AUX.txt", "a. ", "a//b"} {
		if memberPath(name) == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	if _, err := checkedPath(string(bytes.Repeat([]byte("a"), 250)), "python/python.exe"); err == nil {
		t.Fatal("accepted long path")
	}
}
func TestVersionFloor(t *testing.T) {
	if err := newer("0.2.0-build.202610170002", "0.2.0-build.202610170001"); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"0.2.0-build.202610170001", "0.1.0-build.202610170002", "invalid"} {
		if newer(version, "0.2.0-build.202610170001") == nil {
			t.Fatal("accepted stale or invalid version")
		}
	}
}

func TestSignedAdditionalComponentPreparesAndReuses(t *testing.T) {
	p, r, archives := fixture(t)
	extra := r.Components[0]
	extra.Kind = "browser"
	extra.Archive = "browser.zip"
	extra.ContentID = Hash([]byte("browser"))
	r.Components = append(r.Components, extra)
	archives[extra.Kind] = archives["python"]
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	p.Keys["ci"] = base64.StdEncoding.EncodeToString(public)
	raw, _ := json.Marshal(r)
	envelope, _ := json.Marshal(Envelope{Schema: 1, KeyID: "ci", Manifest: base64.StdEncoding.EncodeToString(raw), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw))})
	parsed, err := p.ParseRuntime(envelope, false)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	inputs := t.TempDir()
	for kind, data := range archives {
		if err = os.WriteFile(filepath.Join(inputs, kind+".zip"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	opens := 0
	open := func(c Component) (*os.File, error) { opens++; return os.Open(filepath.Join(inputs, c.Archive)) }
	first, err := p.Prepare(root, parsed, open)
	if err != nil {
		t.Fatal(err)
	}
	second, err := p.Prepare(root, parsed, open)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 6 || len(second) != 6 || opens != 6 || !second[5].Reused {
		t.Fatal("additional signed component was not prepared once and reused")
	}
}

func TestOldPolicyAddsSignedSixthComponentWithoutReopeningExistingArchives(t *testing.T) {
	p, initial, archives := fixture(t)
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	p.Keys["ci"] = base64.StdEncoding.EncodeToString(private.Public().(ed25519.PublicKey))
	frozenPolicy, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	initialBytes, err := json.Marshal(initial)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := p.ParseRuntime(initialBytes, true)
	if err != nil {
		t.Fatal(err)
	}
	root, inputs := t.TempDir(), t.TempDir()
	for kind, data := range archives {
		if err = os.WriteFile(filepath.Join(inputs, kind+".zip"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	initialOpens := 0
	installed, err := p.Prepare(root, baseline, func(c Component) (*os.File, error) {
		initialOpens++
		return os.Open(filepath.Join(inputs, c.Archive))
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(installed) != 5 || initialOpens != 5 {
		t.Fatalf("initial preparation: results=%d archive opens=%d", len(installed), initialOpens)
	}
	before := map[string]os.FileInfo{}
	for i, item := range installed {
		if item.Reused {
			t.Fatalf("initial component unexpectedly reused: %s", item.Kind)
		}
		filename := filepath.Join(item.Directory, filepath.FromSlash(baseline.Components[i].Entry))
		before[filename], err = os.Stat(filename)
		if err != nil {
			t.Fatal(err)
		}
	}

	data := []byte("verified browser")
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	member, err := archive.Create("browser/browser.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = member.Write(data); err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	extra := Component{Kind: "browser", Version: "1.0-r1", ContentID: Hash(data), Archive: "browser.zip",
		ArchiveSHA256: Hash(buffer.Bytes()), ArchiveBytes: int64(buffer.Len()), ExpandedBytes: int64(len(data)),
		FileCount: 1, Entry: "browser/browser.exe", Files: []Member{{Path: "browser/browser.exe", Size: int64(len(data)), SHA256: Hash(data)}}}
	if err = os.WriteFile(filepath.Join(inputs, extra.Archive), buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	next := initial
	next.Components = append(append([]Component(nil), initial.Components...), extra)
	raw, err := json.Marshal(next)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(Envelope{Schema: 1, KeyID: "ci", Manifest: base64.StdEncoding.EncodeToString(raw), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw))})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := p.ParseRuntime(envelope, false)
	if err != nil {
		t.Fatal(err)
	}
	updateOpens := 0
	updated, err := p.Prepare(root, parsed, func(c Component) (*os.File, error) {
		updateOpens++
		if c.Kind != "browser" || c.Archive != "browser.zip" {
			t.Fatalf("update reopened unchanged archive: %s", c.Archive)
		}
		return os.Open(filepath.Join(inputs, c.Archive))
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated) != 6 || updateOpens != 1 {
		t.Fatalf("incremental preparation: results=%d archive opens=%d", len(updated), updateOpens)
	}
	for i, item := range updated {
		if item.Kind != parsed.Components[i].Kind || item.Reused != (i < 5) {
			t.Fatalf("unexpected component reuse: %+v", item)
		}
	}
	for filename, previous := range before {
		after, err := os.Stat(filename)
		if err != nil {
			t.Fatal(err)
		}
		if !os.SameFile(previous, after) || !previous.ModTime().Equal(after.ModTime()) {
			t.Fatalf("update replaced or modified existing entry: %s", filename)
		}
	}
	afterPolicy, err := json.Marshal(p)
	if err != nil || !bytes.Equal(frozenPolicy, afterPolicy) {
		t.Fatal("adding a signed component changed the old helper policy")
	}
}

func TestDirectoryCreationRejectsLinkBeforeWritingOutside(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "runtime")); err != nil {
		t.Skipf("host cannot create symlink: %v", err)
	}
	locks, err := ensureDirectories(root, "runtime/python", false)
	closeFiles(locks)
	if err == nil {
		t.Fatal("accepted linked parent")
	}
	if _, err = os.Stat(filepath.Join(outside, "python")); !os.IsNotExist(err) {
		t.Fatal("wrote beyond linked parent before rejecting")
	}
}

func TestRuntimeRejectsReservedReceiptAndConsumerInvalidVersions(t *testing.T) {
	for _, name := range []string{ReceiptName, ".SCHOLARSEED-COMPONENT.JSON", ReceiptName + "/child"} {
		t.Run(name, func(t *testing.T) {
			p, r, _ := fixture(t)
			r.Components[0].Files[0].Path = name
			r.Components[0].Entry = name
			raw, _ := json.Marshal(r)
			p.RuntimeSHA256 = Hash(raw)
			if _, err := p.ParseRuntime(raw, true); err == nil {
				t.Fatal("accepted reserved receipt path")
			}
		})
	}
	for _, version := range []string{"Version-r1", "1_0-r1", "1.0", "1.0-r0"} {
		p, r, _ := fixture(t)
		r.Components[0].Version = version
		raw, _ := json.Marshal(r)
		p.RuntimeSHA256 = Hash(raw)
		if _, err := p.ParseRuntime(raw, true); err == nil {
			t.Fatalf("accepted version %s", version)
		}
	}
	for _, name := range []string{"CONIN$", "conout$.txt", "path/CONIN$.exe"} {
		if err := memberPath(name); err == nil {
			t.Fatalf("accepted device %s", name)
		}
	}
}

func stageArchives(t *testing.T, root string, r Runtime, archives map[string][]byte) {
	t.Helper()
	directory := joinPath(root, ArchiveDirectory)
	if err := os.MkdirAll(directory, 0755); err != nil {
		t.Fatal(err)
	}
	for _, c := range r.Components {
		filename, err := componentArchive(root, c)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filename, archives[c.Kind], 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExternalArchivesPrepareThenReuseWithoutArchives(t *testing.T) {
	p, r, archives := fixture(t)
	root := t.TempDir()
	stageArchives(t, root, r, archives)
	state := &prepared{request: Request{Root: root}, runtime: r}
	defer state.close()
	space, err := p.preflightComponents(state)
	if err != nil {
		t.Fatal(err)
	}
	var expanded int64
	for _, c := range r.Components {
		expanded += c.ExpandedBytes
	}
	if space != expanded || len(state.archives) != len(r.Components) || len(state.reused) != 0 {
		t.Fatal("preflight did not pin exactly the missing component archives")
	}
	results, err := p.Prepare(root, r, state.archive)
	if err != nil || len(results) != len(r.Components) {
		t.Fatalf("preparation: %v", err)
	}
	state.close()
	if err = os.RemoveAll(joinPath(root, ArchiveDirectory)); err != nil {
		t.Fatal(err)
	}
	reuse := &prepared{request: Request{Root: root}, runtime: r}
	defer reuse.close()
	space, err = p.preflightComponents(reuse)
	if err != nil || space != 0 || len(reuse.archives) != 0 || len(reuse.reused) != len(r.Components) {
		t.Fatalf("valid reuse required downloaded archives: space=%d err=%v", space, err)
	}
}

func TestExternalArchivePreflightRejectsMissingAndChangedBytes(t *testing.T) {
	for _, damage := range []string{"missing", "digest", "size"} {
		t.Run(damage, func(t *testing.T) {
			p, r, archives := fixture(t)
			root := t.TempDir()
			stageArchives(t, root, r, archives)
			filename, _ := componentArchive(root, r.Components[0])
			switch damage {
			case "missing":
				if err := os.Remove(filename); err != nil {
					t.Fatal(err)
				}
			case "digest":
				data := append([]byte(nil), archives[r.Components[0].Kind]...)
				data[0] ^= 1
				if err := os.WriteFile(filename, data, 0600); err != nil {
					t.Fatal(err)
				}
			case "size":
				if err := os.WriteFile(filename, []byte("truncated"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			state := &prepared{request: Request{Root: root}, runtime: r}
			defer state.close()
			if _, err := p.preflightComponents(state); err == nil {
				t.Fatal("accepted unavailable or unauthenticated external archive")
			}
			if _, err := os.Stat(joinPath(root, "runtime/python")); !os.IsNotExist(err) {
				t.Fatal("preflight wrote runtime before rejecting archive")
			}
		})
	}
}

func TestExternalArchivePreflightRejectsLinkedDirectory(t *testing.T) {
	p, r, archives := fixture(t)
	root, external := t.TempDir(), t.TempDir()
	stageArchives(t, external, r, archives)
	if err := os.Mkdir(joinPath(root, "runtime"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(joinPath(external, ArchiveDirectory), joinPath(root, ArchiveDirectory)); err != nil {
		t.Skipf("host cannot create symlink: %v", err)
	}
	state := &prepared{request: Request{Root: root}, runtime: r}
	defer state.close()
	if _, err := p.preflightComponents(state); err == nil {
		t.Fatal("accepted redirected archive directory")
	}
}

func TestExternalArchiveTemporaryPathBudget(t *testing.T) {
	p, r, _ := fixture(t)
	r.Components = r.Components[:1]
	c := &r.Components[0]
	c.Version = string(bytes.Repeat([]byte("1"), 62)) + "-r1"
	c.Entry = "e"
	c.Files[0].Path = c.Entry
	// The permanent ZIP still fits, but its download temporary name exceeds MAX_PATH.
	root := filepath.Join(string(filepath.Separator), string(bytes.Repeat([]byte("a"), 149)))
	if _, err := componentArchive(root, *c); err != nil {
		t.Fatal(err)
	}
	state := &prepared{request: Request{Root: root}, runtime: r}
	defer state.close()
	if _, err := p.preflightComponents(state); err == nil || !strings.Contains(err.Error(), "Windows path exceeds") {
		t.Fatalf("temporary archive path not rejected: %v", err)
	}
}

func TestRuntimeRejectsAmbiguousArchiveNames(t *testing.T) {
	p, r, _ := fixture(t)
	r.Components = r.Components[:2]
	r.Components[0].Kind = "a-b"
	r.Components[0].Archive = "a-b.zip"
	r.Components[0].Version = "1-r1"
	r.Components[1].Kind = "a"
	r.Components[1].Archive = "a.zip"
	r.Components[1].Version = "b-1-r1"
	raw, _ := json.Marshal(r)
	p.RuntimeSHA256 = Hash(raw)
	if _, err := p.ParseRuntime(raw, true); err == nil || !strings.Contains(err.Error(), "archive path collision") {
		t.Fatalf("ambiguous component archives accepted: %v", err)
	}
}

func TestRuntimeRejectsWindowsReservedComponentDirectories(t *testing.T) {
	for _, kind := range []string{"aux", "con", "prn", "nul", "com1", "lpt9"} {
		t.Run("kind-"+kind, func(t *testing.T) {
			p, r, _ := fixture(t)
			r.Components[0].Kind = kind
			r.Components[0].Archive = kind + ".zip"
			raw, _ := json.Marshal(r)
			p.RuntimeSHA256 = Hash(raw)
			if _, err := p.ParseRuntime(raw, true); err == nil {
				t.Fatal("accepted reserved component directory")
			}
		})
	}
	for _, version := range []string{"con.foo-r1", "aux.1-r1", "nul.1-r2", "com1.0-r1", "lpt9.0-r1"} {
		t.Run("version-"+version, func(t *testing.T) {
			p, r, _ := fixture(t)
			r.Components[0].Version = version
			raw, _ := json.Marshal(r)
			p.RuntimeSHA256 = Hash(raw)
			if _, err := p.ParseRuntime(raw, true); err == nil {
				t.Fatal("accepted reserved component version directory")
			}
		})
	}
}
