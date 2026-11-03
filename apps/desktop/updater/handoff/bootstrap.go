package handoff

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	ElectronKind         = "electron"
	VelopackLibrary      = "libvelopack.dll"
	BootstrapChecking    = "checking"
	BootstrapDownloading = "downloading"
	BootstrapVerifying   = "verifying"
	BootstrapPreparing   = "preparing"
)

// LauncherPolicy is frozen into the signed native launcher. It is not loaded
// from requests, the environment, or an adjacent mutable configuration file.
type LauncherPolicy struct {
	Schema            int                        `json:"schema"`
	Policy            Policy                     `json:"policy"`
	ComponentBaseURL  string                     `json:"component_base_url"`
	VelopackDLLSHA256 string                     `json:"velopack_dll_sha256"`
	Messages          map[string]StartupMessages `json:"messages"`
}
type StartupMessages struct {
	Extracting  string `json:"extracting"`
	Title       string `json:"title"`
	Brand       string `json:"brand"`
	Elapsed     string `json:"elapsed"`
	Preparing   string `json:"preparing"`
	Verifying   string `json:"verifying"`
	Downloading string `json:"downloading"`
	Failed      string `json:"failed"`
	Retry       string `json:"retry"`
	Exit        string `json:"exit"`
	Stopping    string `json:"stopping"`
	Cancel      string `json:"cancel"`
}
type BootstrapProgress struct {
	Phase    string
	Received int64
	Total    int64
}
type BootstrapResult struct {
	ComponentResult
	Executable string
}

func ParseLauncherPolicy(encoded string) (LauncherPolicy, error) {
	var result LauncherPolicy
	raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return result, err
	}
	if err = Decode(raw, &result); err != nil {
		return result, err
	}
	policy, err := json.Marshal(result.Policy)
	if err != nil {
		return result, err
	}
	if _, err = ParsePolicy(base64.StdEncoding.EncodeToString(policy)); err != nil {
		return result, err
	}
	if result.Schema != Schema || !digestPattern.MatchString(result.VelopackDLLSHA256) || len(result.Messages) != 2 {
		return result, errors.New("invalid compiled launcher policy")
	}
	if _, err = componentURL(result.ComponentBaseURL, result.Policy.Target, Component{}); err != nil {
		return result, err
	}
	for _, language := range []string{"en", "zh"} {
		messages, ok := result.Messages[language]
		if !ok {
			return result, errors.New("missing launcher language")
		}
		for _, message := range []string{messages.Title, messages.Brand, messages.Elapsed, messages.Preparing, messages.Verifying, messages.Downloading, messages.Failed, messages.Retry, messages.Exit, messages.Stopping, messages.Cancel} {
			if message == "" || len(message) > 4096 || strings.ContainsRune(message, 0) {
				return result, errors.New("invalid launcher message")
			}
		}
		if !strings.Contains(messages.Downloading, "{{name}}") || !strings.Contains(messages.Downloading, "{{percent}}") {
			return result, errors.New("invalid launcher progress message")
		}
	}
	return result, nil
}

// Activate runs the official C ABI before checking installed-current layout.
// Install/update/uninstall fast hooks never need Electron or network access and
// retain the official SDK's lifecycle behavior in staging and installed roots.
func (p LauncherPolicy) Activate() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	directory := filepath.Dir(self)
	parents, err := pinLineage(directory)
	if err != nil {
		return err
	}
	defer closeFiles(parents)
	library := filepath.Join(directory, VelopackLibrary)
	if err = checkLineage(library); err != nil {
		return err
	}
	file, err := pinFile(library)
	if err != nil {
		return err
	}
	defer file.Close()
	digest, err := fileHash(file)
	if err != nil {
		return err
	}
	if digest != p.VelopackDLLSHA256 {
		return errors.New("official Velopack library differs from compiled build")
	}
	return activateVelopack(library)
}

// Bootstrap prepares only the authenticated Electron component. The ordinary
// helper prepare/apply requests still require the full runtime manifest; callers
// cannot supply a subset or redirect the executable/runtime root through IPC.
func (p Policy) Bootstrap(ctx context.Context, root, baseURL string, progress func(BootstrapProgress)) (result BootstrapResult, err error) {
	timing := p.timer(Component{Kind: ElectronKind}, timingBootstrap)
	defer timing.finish(&err)
	end := timing.start(timingIdentity)
	self, err := os.Executable()
	if err != nil {
		return result, err
	}
	current := joinPath(root, "current")
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || !strings.EqualFold(filepath.Clean(self), joinPath(current, p.Executable)) {
		return result, errors.New("launcher must run from this installation's current directory")
	}
	parents, err := pinLineage(current)
	if err != nil {
		return result, err
	}
	defer closeFiles(parents)
	selfFile, err := pinFile(self)
	if err != nil {
		return result, err
	}
	defer selfFile.Close()
	endSignature := timing.start(timingSignature)
	err = verifyAuthenticode(self, p.Signing)
	endSignature()
	if err != nil {
		return result, err
	}
	// An unpacked current directory has neither installation marker. If either
	// exists, require the complete installed identity instead of treating damaged
	// installation metadata as an unpacked application.
	updaterExists, err := regularMarker(joinPath(root, "Update.exe"))
	if err != nil {
		return result, err
	}
	manifestExists, err := regularMarker(joinPath(current, "sq.version"))
	if err != nil {
		return result, err
	}
	if updaterExists || manifestExists {
		if !updaterExists || !manifestExists {
			return result, errors.New("incomplete Velopack installation")
		}
		version, versionErr := installedVersion(root)
		if versionErr != nil {
			return result, versionErr
		}
		if version != p.PackVersion {
			return result, errors.New("launcher and installed version differ")
		}
	}
	end()
	end = timing.start(timingLock)
	unlock, err := installationLock(root)
	if err != nil {
		return result, err
	}
	defer unlock()
	end()
	end = timing.start(timingManifest)
	if err = ctx.Err(); err != nil {
		return result, err
	}
	raw, err := readBounded(joinPath(current, RuntimeManifest), ManifestLimit)
	if err != nil {
		return result, err
	}
	runtime, err := p.ParseRuntime(raw, true)
	if err != nil {
		return result, err
	}
	var component *Component
	for i := range runtime.Components {
		if runtime.Components[i].Kind == ElectronKind {
			component = &runtime.Components[i]
		}
	}
	if component == nil {
		return result, errors.New("runtime manifest has no Electron component")
	}
	timing.event.Version = component.Version
	end()
	end = timing.start(timingReadiness)
	warm, ready, err := p.publishedBootstrap(ctx, root, *component, timing)
	if err != nil {
		return result, err
	}
	if ready {
		timing.event.Status = "reused"
		return warm, nil
	}
	end()
	end = timing.start(timingDownload)
	runtime.Components = []Component{*component}
	if err = p.downloadComponent(ctx, root, baseURL, runtime.Target, *component, progress); err != nil {
		return result, err
	}
	end()
	end = timing.start(timingPreflight)
	prepared := &prepared{request: Request{Root: root}, runtime: runtime}
	defer prepared.close()
	required, err := p.preflightComponents(prepared)
	if err != nil {
		return result, err
	}
	if required > 0 {
		if err = checkSpace(root, required); err != nil {
			return result, err
		}
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	if progress != nil {
		progress(BootstrapProgress{Phase: BootstrapPreparing})
	}
	end()
	end = timing.start(timingPrepare)
	p.observeProgress = func(state ComponentProgress) {
		if progress != nil && state.Phase == "extracting" {
			progress(BootstrapProgress{Phase: BootstrapPreparing, Received: state.Bytes, Total: state.TotalBytes})
		}
	}
	components, err := p.Prepare(root, runtime, prepared.archive)
	if err != nil {
		return result, err
	}
	end()
	// Cancellation during atomic extraction finishes safely and then exits; it
	// never launches Electron or leaves a partially published component behind.
	if err = ctx.Err(); err != nil {
		return result, err
	}
	if len(components) != 1 {
		return result, errors.New("unexpected Electron preparation result")
	}
	executable, err := checkedPath(components[0].Directory, component.Entry)
	if err != nil {
		return result, err
	}
	return BootstrapResult{ComponentResult: components[0], Executable: executable}, nil
}

func regularMarker(filename string) (bool, error) {
	st, err := os.Lstat(filename)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !st.Mode().IsRegular() {
		return false, errors.New("installation marker is not a regular file")
	}
	if err = checkLineage(filename); err != nil {
		return false, err
	}
	return true, nil
}

// Called only after the launcher's installation identity, lock and frozen manifest
// have been authenticated. A ready component never enters preparation.
func (p Policy) publishedBootstrap(ctx context.Context, root string, component Component, timing *componentTimer) (BootstrapResult, bool, error) {
	ready, err := checkReadiness(p, root, component, timing)
	if err != nil {
		return BootstrapResult{}, false, err
	}
	if err = ctx.Err(); err != nil {
		return BootstrapResult{}, false, err
	}
	if !ready {
		return BootstrapResult{}, false, nil
	}
	directory, err := componentDirectory(root, component)
	if err != nil {
		return BootstrapResult{}, false, err
	}
	executable, err := checkedPath(directory, component.Entry)
	if err != nil {
		return BootstrapResult{}, false, err
	}
	return BootstrapResult{ComponentResult: ComponentResult{Kind: component.Kind, Version: component.Version, Directory: directory, Reused: true}, Executable: executable}, true, nil
}
