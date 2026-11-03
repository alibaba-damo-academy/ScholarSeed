package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Build replaces these inputs in a private copy, before branding and signing.
var buildConfiguration string

//go:embed payload.bin
var payload []byte

//go:embed license.txt
var compilerLicense string

type messages struct {
	LegacyRemoval        string `json:"legacyRemoval"`
	LegacyUnknown        string `json:"legacyUnknown"`
	UninstallWaiting     string `json:"uninstallWaiting"`
	UninstallIncomplete  string `json:"uninstallIncomplete"`
	Title                string `json:"title"`
	Heading              string `json:"heading"`
	Description          string `json:"description"`
	Directory            string `json:"directory"`
	Browse               string `json:"browse"`
	Install              string `json:"install"`
	Cancel               string `json:"cancel"`
	Existing             string `json:"existing"`
	Invalid              string `json:"invalid"`
	Failed               string `json:"failed"`
	Unsafe               string `json:"unsafe"`
	InvalidPath          string `json:"invalidPath"`
	TooLong              string `json:"tooLong"`
	InvalidName          string `json:"invalidName"`
	Relocation           string `json:"relocation"`
	Reparse              string `json:"reparse"`
	Protected            string `json:"protected"`
	Drive                string `json:"drive"`
	NotEmpty             string `json:"notEmpty"`
	NotWritable          string `json:"notWritable"`
	Permission           string `json:"permission"`
	Inspection           string `json:"inspection"`
	RiskChanged          string `json:"riskChanged"`
	Launch               string `json:"launch"`
	Risk                 string `json:"risk"`
	RiskEntry            string `json:"riskEntry"`
	RiskTitle            string `json:"riskTitle"`
	RiskSilent           string `json:"riskSilent"`
	RiskQuestion         string `json:"riskQuestion"`
	RiskOwner            string `json:"riskOwner"`
	RiskAccess           string `json:"riskAccess"`
	Installing           string `json:"installing"`
	Preparing            string `json:"preparing"`
	Migration            string `json:"migration"`
	Migrating            string `json:"migrating"`
	MigrationUnsupported string `json:"migrationUnsupported"`
	MigrationRunning     string `json:"migrationRunning"`
	MigrationIncomplete  string `json:"migrationIncomplete"`
	MigrationIdentity    string `json:"migrationIdentity"`
}
type configuration struct {
	AppID         string              `json:"appId"`
	Legacy        *legacyPolicy       `json:"legacy,omitempty"`
	PayloadSHA256 string              `json:"payloadSha256"`
	MaxRootUnits  int                 `json:"maxRootUnits"`
	Messages      map[string]messages `json:"messages"`
}

var errUnsafePermissions = errors.New("installation directory cannot be protected")

func directoryError(text messages, err error) string {
	var issue *directoryIssue
	if errors.As(err, &issue) {
		return formatDirectoryIssue(text, issue)
	}
	if errors.Is(err, errLegacyIdentity) {
		return text.MigrationIdentity
	}
	if errors.Is(err, errLegacyUnsupported) {
		return text.MigrationUnsupported
	}
	if errors.Is(err, errLegacyRunning) {
		return text.MigrationRunning
	}
	if errors.Is(err, errUnsafePermissions) {
		return text.Unsafe
	}
	return err.Error()
}

type options struct {
	Silent              bool
	AcceptDirectoryRisk bool
	Directory           string
	Forward             []string
}

type directoryConsent struct{ Risks []directoryRisk }

func captureDirectoryConsent(risks []directoryRisk) directoryConsent {
	return directoryConsent{Risks: normalizeDirectoryRisks(risks)}
}

func parseOptions(args []string) (options, error) {
	var result options
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--accept-directory-risk":
			result.AcceptDirectoryRisk = true
		case "--":
			result.Forward = append(result.Forward, args[i:]...)
			return result, nil
		case "--silent", "-s":
			result.Silent = true
		case "--installto", "-t":
			if result.Directory != "" || i+1 >= len(args) || args[i+1] == "" {
				return result, errors.New("invalid installation directory argument")
			}
			i++
			result.Directory = args[i]
		case "--log", "-l":
			if i+1 >= len(args) || args[i+1] == "" {
				return result, errors.New("missing log path")
			}
			result.Forward = append(result.Forward, arg, args[i+1])
			i++
		case "--verbose", "-v":
			result.Forward = append(result.Forward, arg)
		default:
			if strings.HasPrefix(arg, "--installto=") && result.Directory == "" && len(arg) > len("--installto=") {
				result.Directory = strings.TrimPrefix(arg, "--installto=")
			} else {
				return result, fmt.Errorf("unsupported installer argument: %s", arg)
			}
		}
	}
	return result, nil
}
func installerArguments(o options, directory string) []string {
	result := []string{"--installto", directory}
	if o.Silent {
		result = append(result, "--silent")
	}
	return append(result, o.Forward...)
}

func authorizeDirectoryRisks(root string, risks []directoryRisk, o options, text messages, confirm func(string) bool) (bool, error) {
	if len(risks) == 0 {
		return true, nil
	}
	body := formatDirectoryRisks(text, root, risks)
	if o.Silent {
		if !o.AcceptDirectoryRisk {
			return false, fmt.Errorf("%s\n\n%s", body, text.RiskSilent)
		}
	} else if !confirm(body + "\n\n" + text.RiskQuestion) {
		return false, nil
	}
	fmt.Fprintln(os.Stderr, "installation directory risk accepted:", root, risks)
	return true, nil
}
func parseConfiguration() (configuration, error) {
	var c configuration
	raw, err := base64.StdEncoding.Strict().DecodeString(buildConfiguration)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	digest := sha256.Sum256(payload)
	if c.AppID != "scholarseed" || c.PayloadSHA256 != hex.EncodeToString(digest[:]) || c.MaxRootUnits <= 3 || c.MaxRootUnits > 259 {
		return c, errors.New("invalid embedded installer configuration")
	}
	if err = validateLegacyPolicy(c.Legacy); err != nil {
		return c, err
	}
	if c.Legacy != nil {
		if _, err = parseLegacyInventory(legacyInventory, c.Legacy); err != nil {
			return c, err
		}
	}
	for _, lang := range []string{"en", "zh"} {
		m := c.Messages[lang]
		for _, message := range []string{m.UninstallWaiting, m.UninstallIncomplete, m.InvalidPath, m.TooLong, m.InvalidName, m.Relocation, m.Reparse, m.Protected, m.Drive, m.NotEmpty, m.NotWritable, m.Permission, m.Inspection, m.RiskChanged, m.Launch, m.Risk, m.RiskEntry, m.RiskTitle, m.RiskSilent, m.RiskQuestion, m.RiskOwner, m.RiskAccess} {
			if message == "" || strings.ContainsRune(message, 0) {
				return c, errors.New("incomplete installer directory localization")
			}
		}
		for _, s := range []string{m.LegacyRemoval, m.LegacyUnknown, m.Title, m.Heading, m.Description, m.Directory, m.Browse, m.Install, m.Cancel, m.Existing, m.Invalid, m.Failed, m.Unsafe, m.Installing, m.Preparing, m.Migration, m.Migrating, m.MigrationUnsupported, m.MigrationRunning, m.MigrationIncomplete, m.MigrationIdentity} {
			if s == "" || strings.ContainsRune(s, 0) {
				return c, errors.New("incomplete installer localization")
			}
		}
	}
	return c, nil
}
func main() { os.Exit(run()) }
func run() int {
	if len(os.Args) == 2 && os.Args[1] == "--licenses" {
		fmt.Print(compilerLicense)
		return 0
	}
	c, err := parseConfiguration()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if len(os.Args) == 2 && os.Args[1] == "--check-policy" {
		fmt.Printf("%s\n", c.PayloadSHA256)
		return 0
	}
	if len(os.Args) > 1 && os.Args[1] == "--legacy-remove" {
		return runLegacyWorker(c, os.Args[2:])
	}
	o, err := parseOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	text := localized(c.Messages)
	fail := func(err error) int {
		if !o.Silent {
			showError(text.Title, text.Failed+"\n\n"+directoryError(text, err))
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	registered, err := registeredDirectory(c.AppID)
	if err != nil {
		return fail(err)
	}
	if registered != "" {
		if err = awaitRemoval(c, text, registered, o.Silent); err != nil {
			return fail(err)
		}
	}
	existing, err := installedDirectory(c.AppID)
	if err != nil {
		return fail(err)
	}
	legacy, err := awaitLegacy(c, text, existing, "", o.Silent)
	if errors.Is(err, errLegacyCancelled) {
		return 0
	}
	if err != nil {
		return fail(err)
	}
	if legacy != nil {
		defer func() {
			if legacy != nil {
				legacy.close()
			}
		}()
		text.Description = text.Migration
		text.Preparing = text.Migrating
	}
	directory := o.Directory
	if existing != "" {
		if directory != "" && !strings.EqualFold(filepath.Clean(directory), filepath.Clean(existing)) {
			return fail(&directoryIssue{Code: directoryRelocation, Path: directory, RegisteredPath: existing})
		}
		directory = existing
	}
	if directory == "" {
		directory, err = defaultDirectory(c.AppID)
		if err != nil {
			return fail(err)
		}
	}
	if err = awaitRemoval(c, text, directory, o.Silent); err != nil {
		return fail(err)
	}
	var acceptedRisks []directoryRisk
	for {
		if !o.Silent {
			var accepted bool
			directory, accepted, err = chooseDirectory(c, text, directory, existing)
			if err != nil {
				return fail(err)
			}
			if !accepted {
				return 0
			}
		}
		directory = filepath.Clean(directory)
		if err = awaitRemoval(c, text, directory, o.Silent); err != nil {
			return fail(err)
		}
		acceptedRisks, err = assessDirectory(directory, existing, c)
		if err != nil {
			return fail(err)
		}
		accepted, authorizeErr := authorizeDirectoryRisks(directory, acceptedRisks, o, text, func(body string) bool {
			return confirmDirectoryRisk(text.RiskTitle, body)
		})
		if authorizeErr != nil {
			return fail(authorizeErr)
		}
		if accepted {
			break
		}
	}
	if legacy != nil {
		legacy.close()
		legacy, err = awaitLegacy(c, text, existing, directory, o.Silent)
		if errors.Is(err, errLegacyCancelled) {
			return 0
		}
		if err != nil {
			return fail(err)
		}
		if legacy == nil {
			text = localized(c.Messages)
		}
	}
	temporary, err := os.MkdirTemp("", "scholarseed-setup-")
	if err != nil {
		return fail(err)
	}
	defer os.RemoveAll(temporary)
	filename := filepath.Join(temporary, "ScholarSeed-Engine-Setup.exe")
	if err = os.WriteFile(filename, payload, 0600); err != nil {
		return fail(err)
	}
	// Re-read the exact executable just written, never run a neighboring download.
	file, err := holdPayload(filename)
	if err != nil {
		return fail(err)
	}
	defer file.Close()
	written, err := io.ReadAll(file)
	if err != nil {
		return fail(err)
	}
	digest := sha256.Sum256(written)
	if hex.EncodeToString(digest[:]) != c.PayloadSHA256 {
		return fail(errors.New("embedded installer changed"))
	}
	retiredLegacy := false
	operation := func() (operationErr error) {
		// The chooser can remain open while another installer registers an old
		// client. Fresh installation must not silently turn into coexistence.
		if legacy == nil {
			appeared, checkErr := discoverLegacy(c.Legacy, existing)
			if checkErr != nil {
				return checkErr
			}
			if appeared != nil {
				defer appeared.close()
				return &legacyIssue{Path: appeared.path(), Cause: errLegacyChanged}
			}
		}
		// A maintenance operation may have started while the chooser was open.
		// Refuse before taking directory pins or mutating the installation.
		removal, err := inspectRemoval(directory, c.AppID)
		if err != nil {
			return err
		}
		if removal.active || removal.incomplete {
			return &directoryIssue{Code: directoryUninstall, Path: directory}
		}
		pins, err := pinInstallationParent(directory)
		if err != nil {
			return &directoryIssue{Code: directoryInspection, Path: directory, Cause: err}
		}
		defer func() {
			if closeErr := pins.close(); closeErr != nil {
				operationErr = errors.Join(operationErr, &directoryIssue{Code: directoryInspection, Path: directory, Cause: closeErr})
			}
		}()
		risks, err := assessDirectory(directory, existing, c)
		if err != nil {
			return err
		}
		if !sameDirectoryRisks(risks, acceptedRisks) {
			return &directoryIssue{Code: directoryRiskChanged, Path: directory}
		}
		consent := captureDirectoryConsent(acceptedRisks)
		if err := pins.prepare(); err != nil {
			return &directoryIssue{Code: directoryNotWritable, Path: directory, Cause: err}
		}
		if err := prepareInstallationDirectory(directory, existing, c, consent); err != nil {
			return err
		}
		if err := pins.replace(directory, func() error {
			if legacy != nil {
				if err := legacy.remove(temporary, directory); err != nil {
					return err
				}
				retiredLegacy = true
			}
			// The official engine owns replacement/hooks/registration. Suppress its
			// normal launch until this application's directory permissions are ready.
			inner := o
			inner.Silent = true
			command := exec.Command(filename, installerArguments(inner, directory)...)
			if legacy != nil {
				command.Env = legacy.environment(os.Environ())
			}
			command.Stdout, command.Stderr = os.Stdout, os.Stderr
			return command.Run()
		}); err != nil {
			return err
		}
		if err := verifyInstalled(directory, c.AppID); err != nil {
			return err
		}
		if err := secureInstallation(directory); err != nil {
			return &directoryIssue{Code: directoryPermission, Path: directory, Cause: err}
		}
		return nil
	}
	if o.Silent {
		err = operation()
	} else {
		err = performInstallation(c, text, directory, operation)
	}
	if err != nil {
		if retiredLegacy {
			text.Failed = text.MigrationIncomplete
		}
		return fail(err)
	}
	if legacy != nil {
		if err = legacy.unchanged(); err != nil {
			return fail(err)
		}
	}
	if !o.Silent {
		args := []string{"--rootDir", directory, "start"}
		for i, arg := range o.Forward {
			if arg == "--" {
				args = append(args, o.Forward[i:]...)
				break
			}
		}
		command := exec.Command(filepath.Join(directory, "Update.exe"), args...)
		environment := os.Environ()
		if legacy != nil {
			environment = legacy.environment(environment)
		}
		command.Env = append(environment, "VELOPACK_FIRSTRUN=true")
		if err := command.Start(); err != nil {
			issue := &directoryIssue{Code: directoryLaunch, Path: directory, Cause: err}
			showError(text.Title, directoryError(text, issue))
			fmt.Fprintln(os.Stderr, issue)
			return 1
		}
		_ = command.Process.Release()
	}
	return 0
}
