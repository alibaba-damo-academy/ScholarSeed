package handoff

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComponentDownload(t *testing.T) {
	p, r, archives := fixture(t)
	c := r.Components[0]
	bytes := archives[c.Kind]
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(bytes) }))
	defer server.Close()
	root := t.TempDir()
	archive := filepath.Join(root, c.Archive)
	if err := receiveComponent(context.Background(), server.Client(), server.URL, archive, c, nil); err != nil {
		t.Fatal(err)
	}
	reader := func(Component) (*os.File, error) { return os.Open(archive) }
	if _, err := p.Prepare(root, Runtime{Components: []Component{c}}, reader); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	// The existing receipt/entry authority permits reuse with neither an archive
	// nor a reachable server; it is exactly the helper's checkReuse implementation.
	if err := p.downloadComponent(context.Background(), root, "https://unreachable.invalid", r.Target, c, nil); err != nil {
		t.Fatal(err)
	}
	directory, _ := componentDirectory(root, c)
	if err := os.WriteFile(joinPath(directory, c.Entry), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := p.downloadComponent(context.Background(), root, "https://unreachable.invalid", r.Target, c, nil); err == nil {
		t.Fatal("changed cached entry accepted")
	}
}

func TestDownloadRejectsBadBytes(t *testing.T) {
	_, r, archives := fixture(t)
	c := r.Components[0]
	payload := archives[c.Kind]
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	for name, mutate := range map[string]func(*Component){"digest": func(c *Component) { c.ArchiveSHA256 = strings.Repeat("0", 64) }, "length": func(c *Component) { c.ArchiveBytes-- }} {
		t.Run(name, func(t *testing.T) {
			bad := c
			mutate(&bad)
			root := t.TempDir()
			target := filepath.Join(root, "bad.zip")
			if err := receiveComponent(context.Background(), server.Client(), server.URL, target, bad, nil); err == nil {
				t.Fatal("bad bytes accepted")
			}
			files, err := os.ReadDir(root)
			if err != nil || len(files) != 0 {
				t.Fatalf("partial bytes retained: %v %v", files, err)
			}
		})
	}
	if err := receiveComponent(context.Background(), componentClient(), server.URL, filepath.Join(t.TempDir(), "untrusted.zip"), c, nil); err == nil {
		t.Fatal("untrusted server certificate accepted")
	}
}

func TestDownloadCancellationAndRedirect(t *testing.T) {
	bytes := []byte(strings.Repeat("a", 256*1024))
	c := Component{ArchiveBytes: int64(len(bytes)), ArchiveSHA256: Hash(bytes)}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(bytes) }))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	root := t.TempDir()
	err := receiveComponent(ctx, server.Client(), server.URL, filepath.Join(root, "cancel.zip"), c, func(BootstrapProgress) { cancel() })
	if err == nil {
		t.Fatal("cancelled archive published")
	}
	files, err := os.ReadDir(root)
	if err != nil || len(files) != 0 {
		t.Fatal("cancelled download residue")
	}
	client := componentClient()
	for _, address := range []string{"http://updates.example/file", "https://user@updates.example/file"} {
		request, _ := http.NewRequest(http.MethodGet, address, nil)
		if err = client.CheckRedirect(request, nil); err == nil {
			t.Fatal("unsafe redirect accepted")
		}
	}
	request, _ := http.NewRequest(http.MethodGet, "https://updates.example/file", nil)
	if err = client.CheckRedirect(request, make([]*http.Request, componentRedirects+1)); err == nil {
		t.Fatal("redirect limit ignored")
	}
}

func TestDownloadPathPreflight(t *testing.T) {
	p, r, _ := fixture(t)
	c := r.Components[0]
	c.Files[0].Path = strings.Repeat("a", 240) + "/entry.exe"
	root := t.TempDir()
	if err := p.downloadComponent(context.Background(), root, "https://updates.example", r.Target, c, nil); err == nil {
		t.Fatal("long destination accepted")
	}
	files, err := os.ReadDir(root)
	if err != nil || len(files) != 0 {
		t.Fatal("preflight wrote destination")
	}
}
