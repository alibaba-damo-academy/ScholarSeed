package handoff

import (
	"archive/zip"
	"bufio"
	"crypto/rand"
	"encoding/hex"
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

const WorkerWait = 30 * time.Minute
const WorkerStopWait = 15 * time.Second

const operationGroup = "group"
const operationInspect = "inspect"

type UpdateRecoveryError struct {
	ProcessesExited bool
	Cause           error
}

func (failure *UpdateRecoveryError) Error() string {
	message := "update interrupted; installation requires repair"
	if !failure.ProcessesExited {
		message = "update interrupted; process cleanup is unconfirmed"
	}
	if failure.Cause != nil {
		message += ": " + failure.Cause.Error()
	}
	return message
}

func (failure *UpdateRecoveryError) Unwrap() error { return failure.Cause }

func remainingWait(deadline time.Time) time.Duration {
	remaining := time.Until(deadline)
	if remaining < 0 {
		return 0
	}
	return remaining
}

func interruptUpdate(worker workerProcess, job updateJob, cause error, budget time.Duration) *UpdateRecoveryError {
	deadline := time.Now().Add(budget)
	terminationErr := job.Terminate()
	_, workerErr := worker.Wait(remainingWait(deadline))
	jobErr := job.Wait(remainingWait(deadline))
	return &UpdateRecoveryError{
		ProcessesExited: workerErr == nil && jobErr == nil,
		Cause:           errors.Join(cause, terminationErr, workerErr, jobErr),
	}
}

func drainUpdate(worker workerProcess, job updateJob, deadline time.Time) *UpdateRecoveryError {
	if err := job.Wait(remainingWait(deadline)); err != nil {
		return interruptUpdate(worker, job, err, WorkerStopWait)
	}
	return nil
}

var requestName = regexp.MustCompile(`^request-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$`)

type Request struct {
	Schema          int             `json:"schema"`
	Operation       string          `json:"operation"`
	Root            string          `json:"root"`
	PackagePath     string          `json:"packagePath"`
	ReleaseEnvelope json.RawMessage `json:"releaseEnvelope"`
	MainPID         uint32          `json:"mainPid"`
	RestartArgs     []string        `json:"restartArgs"`
	DiagnosticFile  string          `json:"diagnosticFile,omitempty"`
}
type Event struct {
	RuntimeReady  *bool              `json:"runtimeReady,omitempty"`
	Progress      *ComponentProgress `json:"progress,omitempty"`
	Event         string             `json:"event"`
	Message       string             `json:"message,omitempty"`
	PackageSHA256 string             `json:"packageSha256,omitempty"`
	PackageBytes  int64              `json:"packageBytes,omitempty"`
	Components    []ComponentResult  `json:"components,omitempty"`
	PrincipalSID  string             `json:"principalSid,omitempty"`
}
type prepared struct {
	request     Request
	locks       []*os.File
	archives    map[string]*os.File
	packageFile *os.File
	zip         *zip.Reader
	runtime     Runtime
	release     Release
	packageSHA  string
	packageSize int64
	reused      []ComponentResult
	main        processWaiter
	admission   *toolAdmission
}

// Transfer one preflight-verified handle to Prepare, which closes it after use.
func (r *prepared) archive(c Component) (*os.File, error) {
	file := r.archives[c.Kind]
	if file == nil {
		return nil, errors.New("component was not pinned before commit")
	}
	delete(r.archives, c.Kind)
	return file, nil
}

func (r *prepared) close() {
	for kind, file := range r.archives {
		file.Close()
		delete(r.archives, kind)
	}
	if r.main != nil {
		r.main.Close()
	}
	for i := len(r.locks) - 1; i >= 0; i-- {
		r.locks[i].Close()
	}
}
func emit(event Event) { _ = json.NewEncoder(os.Stdout).Encode(event) }

func validateRequest(r Request) error {
	if r.Schema != Schema || (r.Operation != operationGroup && r.Operation != operationInspect && r.Operation != "prepare" && r.Operation != "apply") || !filepath.IsAbs(r.Root) || filepath.Clean(r.Root) != r.Root {
		return errors.New("invalid handoff request")
	}
	if err := validateRestartArguments(r.RestartArgs); err != nil {
		return err
	}
	if r.Operation != "apply" && r.DiagnosticFile != "" {
		return errors.New("only application updates may carry diagnostic output")
	}
	if (r.Operation == operationInspect || r.Operation == operationGroup) && (r.PackagePath != "" || len(r.ReleaseEnvelope) != 0 || len(r.RestartArgs) != 0) {
		return errors.New("readiness/group request cannot contain update inputs")
	}
	return nil
}

func (p Policy) openRequest(filename string) (result *prepared, err error) {
	timing := p.timer(Component{Kind: "handoff"}, timingRequest)
	defer timing.finish(&err)
	done := timing.start(timingLineage)
	result = &prepared{}
	opened := result
	defer func() {
		if err != nil {
			opened.close()
		}
	}()
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	selfParents, err := pinLineage(filepath.Dir(self))
	if err != nil {
		return nil, err
	}
	result.locks = append(result.locks, selfParents...)
	selfFile, err := pinFile(self)
	if err != nil {
		return nil, err
	}
	result.locks = append(result.locks, selfFile)
	if err = checkLineage(filename); err != nil {
		return nil, err
	}
	ancestors, err := pinLineage(filepath.Dir(filename))
	if err != nil {
		return nil, err
	}
	result.locks = append(result.locks, ancestors...)
	f, err := pinFile(filename)
	if err != nil {
		return nil, err
	}
	result.locks = append(result.locks, f)
	raw, err := io.ReadAll(io.LimitReader(f, ManifestLimit+1))
	if err != nil {
		return nil, err
	}
	if err = Decode(raw, &result.request); err != nil {
		return nil, err
	}
	r := result.request
	if err = validateRequest(r); err != nil {
		return nil, err
	}
	if err = checkLineage(r.Root); err != nil {
		return nil, err
	}
	ancestors, err = pinLineage(r.Root)
	if err != nil {
		return nil, err
	}
	result.locks = append(result.locks, ancestors...)
	done()
	done = timing.start(timingIdentity)
	if err = validateRoot(p, r.Root); err != nil {
		return nil, err
	}
	done()
	if r.Operation == operationGroup {
		return result, nil
	}
	done = timing.start(timingPrincipal)
	if p.toolAdmission == nil {
		principal, resolveErr := resolveToolPrincipal()
		if resolveErr != nil {
			if r.Operation != operationInspect || !toolPrincipalMissing(resolveErr) {
				return nil, resolveErr
			}
		} else {
			p.toolAdmission = &toolAdmission{principal: principal}
		}
	}
	done()
	done = timing.start(timingManifest)
	result.admission = p.toolAdmission
	if r.Operation == "apply" {
		if r.MainPID == 0 || !filepath.IsAbs(r.PackagePath) || len(r.ReleaseEnvelope) == 0 {
			return nil, errors.New("invalid apply request")
		}
		result.main, err = openProcessWaiter(r.MainPID)
		if err != nil {
			return nil, err
		}
		updater := joinPath(r.Root, "Update.exe")
		if err = checkLineage(updater); err != nil {
			return nil, err
		}
		updaterFile, openErr := pinFile(updater)
		if openErr != nil {
			return nil, openErr
		}
		result.locks = append(result.locks, updaterFile)
		if err = verifyAuthenticode(updater, p.Signing); err != nil {
			return nil, err
		}
		if err = checkLineage(r.PackagePath); err != nil {
			return nil, err
		}
		ancestors, err = pinLineage(filepath.Dir(r.PackagePath))
		if err != nil {
			return nil, err
		}
		result.locks = append(result.locks, ancestors...)
		file, err := pinFile(r.PackagePath)
		if err != nil {
			return nil, err
		}
		result.locks = append(result.locks, file)
		result.packageFile = file
		if result.zip, result.release, err = p.verifyRelease(r.ReleaseEnvelope, file, r.Root); err != nil {
			return nil, err
		}
		if result.packageSHA, err = fileHash(file); err != nil {
			return nil, err
		}
		st, _ := file.Stat()
		result.packageSize = st.Size()
		raw, err = zipBytes(result.zip, "lib/app/"+RuntimeManifest, ManifestLimit)
		if err != nil {
			return nil, err
		}
		result.runtime, err = p.ParseRuntime(raw, false)
	} else {
		raw, err = readBounded(joinPath(r.Root, "current/"+RuntimeManifest), ManifestLimit)
		if err == nil {
			result.runtime, err = p.ParseRuntime(raw, true)
		}
	}
	if err != nil {
		return nil, err
	}
	done()
	if r.Operation == operationInspect {
		return result, nil
	}
	done = timing.start(timingPreflight)
	requiredSpace, err := p.preflightComponents(result)
	if err != nil {
		return nil, err
	}
	if r.Operation == "apply" {
		for _, m := range result.release.Files {
			requiredSpace += m.Size
		}
	}
	if requiredSpace > 0 {
		if err = checkSpace(r.Root, requiredSpace); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func validateRoot(p Policy, root string) (err error) {
	timing := p.timer(Component{Kind: "handoff"}, timingIdentity)
	defer timing.finish(&err)
	done := timing.start(timingHash)
	// The elevated operation is bound to an existing installation of this exact
	// helper build, never an arbitrary caller-supplied destination directory.
	self, err := os.Executable()
	if err != nil {
		return err
	}
	own, err := pinFile(self)
	if err != nil {
		return err
	}
	defer own.Close()
	expected, err := fileHash(own)
	if err != nil {
		return err
	}
	installed := joinPath(root, HelperRelative)
	if err = checkLineage(installed); err != nil {
		return err
	}
	f, err := pinFile(installed)
	if err != nil {
		return err
	}
	defer f.Close()
	actual, err := fileHash(f)
	if err != nil {
		return err
	}
	done()
	if expected != actual {
		return errors.New("installed helper differs from running build")
	}
	done = timing.start(timingLineage)
	main := joinPath(root, "current/"+p.Executable)
	if err = checkLineage(main); err != nil {
		return err
	}
	mainLocks, err := pinLineage(filepath.Dir(main))
	if err != nil {
		return err
	}
	defer closeFiles(mainLocks)
	mainFile, err := pinFile(main)
	if err != nil {
		return err
	}
	defer mainFile.Close()
	st, err := mainFile.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return errors.New("invalid installed application")
	}
	done()
	done = timing.start(timingSignature)
	defer done()
	return verifyAuthenticodeFiles([]string{installed, main}, p.Signing)
}

func commandReader(input io.Reader) <-chan string {
	result := make(chan string)
	go func() {
		defer close(result)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 256), 4096)
		for scanner.Scan() {
			var command struct {
				Command string `json:"command"`
			}
			if Decode(scanner.Bytes(), &command) != nil {
				return
			}
			result <- command.Command
		}
	}()
	return result
}
func takeCommand(commands <-chan string, wanted string) error {
	select {
	case command, ok := <-commands:
		if !ok || command != wanted {
			return errors.New("handoff cancelled before commit")
		}
		return nil
	case <-time.After(WorkerWait):
		return errors.New("handoff command timeout")
	}
}

// Coordinate is the original-user process. It must live outside the complete
// installation root, because the official updater stops all processes there.
func (p Policy) Coordinate(filename string) (err error) {
	timing := p.timer(Component{Kind: "handoff"}, timingCoordinator)
	defer timing.finish(&err)
	done := timing.start(timingRequest)
	r, err := p.openRequest(filename)
	if err != nil {
		return err
	}
	cleanupConfirmed := true
	defer func() {
		r.close()
		if cleanupConfirmed {
			cleanupRequest(filename)
		}
	}()
	done()
	timing.event.Version = r.request.Operation
	p.toolAdmission = r.admission
	self, _ := os.Executable()
	if inside(r.request.Root, self) {
		return errors.New("coordinator must run outside installation root")
	}
	commands := commandReader(os.Stdin)
	done = timing.start(timingAuthorize)
	emit(Event{Event: "ready", PackageSHA256: r.packageSHA, PackageBytes: r.packageSize})
	if err = takeCommand(commands, "start"); err != nil {
		return err
	}
	done()
	if r.request.Operation == operationInspect {
		ready, inspectErr := p.inspectRuntime(r, timing)
		if inspectErr != nil {
			return inspectErr
		}
		emit(Event{Event: "authorized"})
		done = timing.start(timingCommit)
		if err = takeCommand(commands, "commit"); err != nil {
			return err
		}
		event := Event{Event: "complete", RuntimeReady: &ready}
		if ready {
			event.PrincipalSID = p.toolAdmission.principal
		}
		emit(event)
		return nil
	}
	if r.request.Operation == operationGroup {
		done = timing.start(timingPrincipal)
		principal, resolveErr := resolveToolPrincipal()
		if resolveErr == nil {
			done()
			done = timing.start(timingCommit)
			emit(Event{Event: "authorized"})
			if err = takeCommand(commands, "commit"); err != nil {
				return err
			}
			done()
			done = timing.start(timingPrincipal)
			actual, verifyErr := resolveToolPrincipal()
			if verifyErr != nil {
				return verifyErr
			}
			if actual != principal {
				return errors.New("sandbox principal changed during authorization")
			}
			emit(Event{Event: "complete", PrincipalSID: actual})
			return nil
		}
		if !toolPrincipalMissing(resolveErr) {
			return resolveErr
		}
	}
	done()
	if r.request.Operation == "prepare" && len(r.reused) == len(r.runtime.Components) {
		done = timing.start(timingAdmission)
		coordinator, authorityErr := openProcessWaiter(uint32(os.Getpid()))
		if authorityErr != nil {
			return authorityErr
		}
		p.toolAdmission, authorityErr = toolAdmissionFor(coordinator)
		coordinator.Close()
		if authorityErr != nil {
			return authorityErr
		}
		done()
		done = timing.start(timingTools)
		ready, readyErr := p.applicationToolsReady(r.request.Root, r.runtime, p.PackVersion)
		if readyErr != nil {
			return readyErr
		}
		done()
		if ready {
			done = timing.start(timingCommit)
			emit(Event{Event: "authorized"})
			if err = takeCommand(commands, "commit"); err != nil {
				return err
			}
			emit(Event{Event: "complete", Components: r.reused, PrincipalSID: p.toolAdmission.principal})
			return nil
		}
	}
	working, err := os.MkdirTemp(filepath.Dir(filename), "handoff-")
	if err != nil {
		return err
	}
	defer func() {
		if cleanupConfirmed {
			os.RemoveAll(working)
		}
	}()
	status := filepath.Join(working, "status.json")
	control := filepath.Join(working, "control.json")
	nonceBytes := make([]byte, 24)
	if _, err = rand.Read(nonceBytes); err != nil {
		return err
	}
	nonce := hex.EncodeToString(nonceBytes)
	var job updateJob
	if r.request.Operation == "apply" {
		job, err = newUpdateJob(nonce)
		if err != nil {
			return err
		}
		defer job.Close()
	}
	if err = os.WriteFile(status, []byte("{}"), 0600); err != nil {
		return err
	}
	if err = os.WriteFile(control, []byte("{}"), 0600); err != nil {
		return err
	}
	channelLocks, err := pinLineage(working)
	if err != nil {
		return err
	}
	defer closeFiles(channelLocks)
	statusFile, err := openChannel(status, false)
	if err != nil {
		return err
	}
	defer statusFile.Close()
	defer func() {
		if state, err := readWorkerStatus(statusFile, nonce); err == nil {
			writeTimings(state.Timings)
		}
	}()
	controlFile, err := openChannel(control, true)
	if err != nil {
		return err
	}
	defer controlFile.Close()
	elevate := r.request.Operation == operationGroup || !rootWritable(r.request.Root)
	if elevate {
		for _, name := range []string{filename, self, control, r.request.PackagePath} {
			if name != "" {
				if err = grantAdministrators(name, false); err != nil {
					return err
				}
			}
		}
		if err = grantAdministrators(status, true); err != nil {
			return err
		}
	}
	worker, err := startWorker(self, []string{"--worker", filename, "--status", status, "--control", control, "--nonce", nonce, "--parent", fmt.Sprint(os.Getpid())}, elevate)
	if errors.Is(err, ErrCancelled) {
		emit(Event{Event: "cancelled"})
		return nil
	}
	if err != nil {
		return err
	}
	defer worker.Close()
	interrupted := func(cause error) error {
		failure := interruptUpdate(worker, job, cause, WorkerStopWait)
		cleanupConfirmed = failure.ProcessesExited
		return failure
	}
	committed := false
	defer func() {
		if !committed {
			worker.Terminate()
			worker.Wait(WorkerWait)
		}
	}()
	if _, err = waitWorkerStatus(worker, statusFile, nonce, "authorized"); err != nil {
		return err
	}
	emit(Event{Event: "authorized"})
	if err = takeCommand(commands, "commit"); err != nil {
		return err
	}
	// The caller treats writing commit as irrevocable. From here this process
	// owns waiting or terminating the invocation before reporting its outcome.
	committed = true
	operationDeadline := time.Now().Add(WorkerWait)
	err = writeWorkerStatus(controlFile, workerStatus{Nonce: nonce, Event: "commit"})
	if err != nil {
		if job != nil {
			return interrupted(err)
		}
		worker.Terminate()
	} else if r.request.Operation == "apply" {
		emit(Event{Event: "started"})
	}
	var resume func() error
	finish := func(observe func(ComponentProgress)) error {
		workerBudget := WorkerWait
		if job != nil {
			workerBudget = remainingWait(operationDeadline)
		}
		code, waitErr := waitWorkerProgress(worker, statusFile, nonce, r.request.Operation == "prepare" || r.request.Operation == "apply", workerBudget, observe)
		if waitErr != nil { // Never restart while a worker or updater might still run.
			if job != nil {
				return interrupted(waitErr)
			}
			return fmt.Errorf("worker completion unconfirmed: %w", waitErr)
		}
		if job != nil {
			if failure := drainUpdate(worker, job, operationDeadline); failure != nil {
				cleanupConfirmed = failure.ProcessesExited
				return failure
			}
		}
		if r.request.Operation == "prepare" || r.request.Operation == operationGroup {
			if err != nil {
				return err
			}
			if code != 0 {
				return errors.New("runtime preparation failed")
			}
			state, err := readWorkerStatus(statusFile, nonce)
			if err != nil {
				return err
			}
			if r.request.Operation == operationGroup {
				if state.Event != "complete" {
					return errors.New("sandbox group worker did not complete")
				}
				principal, resolveErr := resolveToolPrincipal()
				if resolveErr != nil {
					return resolveErr
				}
				if principal != state.PrincipalSID {
					return errors.New("sandbox group worker result differs from the local principal")
				}
				emit(Event{Event: "complete", PrincipalSID: principal})
			} else {
				principal, principalErr := resolveToolPrincipal()
				if principalErr != nil || state.Event != "complete" || principal != state.PrincipalSID || principal != p.toolAdmission.principal {
					return errors.Join(principalErr, errors.New("runtime preparation principal differs at completion"))
				}
				emit(Event{Event: "complete", Components: state.Components, PrincipalSID: principal})
			}
			return nil
		}
		if err = r.main.Wait(remainingWait(operationDeadline)); err != nil {
			return interrupted(err)
		}
		// Do not restore backups or judge health. Only start a structurally valid
		// existing installation after all owned installer processes have finished.
		current, versionErr := installedVersion(r.request.Root)
		if versionErr != nil {
			return versionErr
		}
		if current != p.PackVersion && current != r.release.PackVersion {
			return errors.New("unexpected installed version after apply")
		}
		// Resolve/write diagnostics only in the original-user coordinator, after the
		// old app has exited. Workers never use this optional diagnostic path.
		if observe != nil {
			observe(ComponentProgress{Phase: updateRestarting})
		}
		resume = func() error {
			restartLog := openRestartDiagnostics(filename, r.request.DiagnosticFile, p.PackVersion, r.release.PackVersion)
			defer restartLog.close()
			return restartUpdatedApplication(joinPath(r.request.Root, "current/"+p.Executable), r.request.RestartArgs, refreshApplicationIcons, restart, restartLog)
		}
		if code != 0 {
			return fmt.Errorf("update failed (%d); existing current will restart after this notice closes", code)
		}
		return nil
	}
	if r.request.Operation == "apply" {
		return presentUpdate(func(observe func(ComponentProgress)) (func() error, error) {
			outcome := finish(observe)
			return resume, outcome
		}, func(run func(func(ComponentProgress)) error) error {
			return updateWindow(p.UpdateMessages, run)
		})
	}
	return finish(nil)
}

func cleanupRequest(filename string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	if strings.EqualFold(filepath.Clean(filepath.Dir(self)), filepath.Clean(filepath.Dir(filename))) && requestName.MatchString(filepath.Base(filename)) {
		_ = os.Remove(filename)
	}
}

type workerStatus struct {
	Stage        string             `json:"stage,omitempty"`
	Progress     *ComponentProgress `json:"progress,omitempty"`
	Timings      []ComponentTiming  `json:"timings,omitempty"`
	Nonce        string             `json:"nonce"`
	Event        string             `json:"event"`
	Message      string             `json:"message,omitempty"`
	Components   []ComponentResult  `json:"components,omitempty"`
	PrincipalSID string             `json:"principalSid,omitempty"`
}

func readWorkerStatus(file *os.File, nonce string) (workerStatus, error) {
	var result workerStatus
	_, err := file.Seek(0, io.SeekStart)
	if err != nil {
		return result, err
	}
	raw, err := io.ReadAll(io.LimitReader(file, 1024*1024))
	if err != nil {
		return result, err
	}
	if err = Decode(raw, &result); err != nil {
		return result, err
	}
	if result.Nonce != nonce {
		return result, errors.New("worker status not ready")
	}
	return result, nil
}
func writeWorkerStatus(file *os.File, state workerStatus) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err = file.Truncate(0); err != nil {
		return err
	}
	if _, err = file.Write(raw); err != nil {
		return err
	}
	return file.Sync()
}
func waitWorkerStatus(worker workerProcess, file *os.File, nonce, event string) (workerStatus, error) {
	deadline := time.Now().Add(WorkerWait)
	for time.Now().Before(deadline) {
		if state, err := readWorkerStatus(file, nonce); err == nil {
			if state.Event == event {
				return state, nil
			}
			if state.Event == "error" {
				return state, errors.New(state.Message)
			}
		}
		if done, err := worker.Done(); err != nil || done {
			return workerStatus{}, errors.New("worker exited before authorization")
		}
		time.Sleep(50 * time.Millisecond)
	}
	return workerStatus{}, errors.New("worker authorization timeout")
}

func (p Policy) Worker(filename, status, control, nonce string, parent uint32) (err error) {
	var timings []ComponentTiming
	p.observeTiming = func(event ComponentTiming) { timings = append(timings, event) }
	if len(nonce) != 48 || parent == 0 || filepath.Dir(status) != filepath.Dir(control) || filepath.Base(status) != "status.json" || filepath.Base(control) != "control.json" || filepath.Dir(filepath.Dir(status)) != filepath.Dir(filename) || !strings.HasPrefix(filepath.Base(filepath.Dir(status)), "handoff-") {
		return errors.New("invalid worker channel")
	}
	parentProcess, err := openProcessWaiter(parent)
	if err != nil {
		return err
	}
	defer parentProcess.Close()
	for _, name := range []string{status, control} {
		if err = checkLineage(name); err != nil {
			return err
		}
	}
	channelLocks, err := pinLineage(filepath.Dir(status))
	if err != nil {
		return err
	}
	defer closeFiles(channelLocks)
	statusFile, err := openChannel(status, true)
	if err != nil {
		return err
	}
	defer statusFile.Close()
	controlFile, err := openChannel(control, false)
	if err != nil {
		return err
	}
	defer controlFile.Close()
	defer func() {
		if err != nil {
			_ = writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "error", Message: err.Error(), Timings: timings})
		}
	}()
	r, err := p.openRequest(filename)
	if err != nil {
		return err
	}
	defer r.close()
	if r.request.Operation == operationInspect {
		return errors.New("inspection cannot run in a worker")
	}
	var updaterJob updaterInvocation
	if r.request.Operation == "apply" {
		updaterJob, err = openUpdaterJob(nonce)
		if err != nil {
			return fmt.Errorf("updater job authorization failed: %w", err)
		}
		defer updaterJob.Close()
		if err = updaterJob.Admit(); err != nil {
			return fmt.Errorf("updater worker job admission failed: %w", err)
		}
	}
	if err = writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "authorized"}); err != nil {
		return err
	}
	deadline := time.Now().Add(WorkerWait)
	accepted := false
	for time.Now().Before(deadline) {
		if state, readErr := readWorkerStatus(controlFile, nonce); readErr == nil && state.Event == "commit" {
			accepted = true
			break
		}
		if !parentProcess.Alive() {
			return errors.New("coordinator exited before commit")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !accepted {
		return errors.New("commit timeout")
	}
	if err = writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "accepted"}); err != nil {
		return err
	}
	if r.request.Operation == operationGroup {
		principal, provisionErr := ensureToolPrincipal()
		if provisionErr != nil {
			return provisionErr
		}
		return writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "complete", PrincipalSID: principal})
	}
	p.toolAdmission, err = toolAdmissionFor(parentProcess)
	if err != nil {
		return err
	}
	if r.admission == nil || p.toolAdmission.principal != r.admission.principal {
		return errors.New("sandbox principal changed after installation preflight")
	}
	if r.request.Operation == "apply" {
		if err = r.main.Wait(WorkerWait); err != nil {
			return err
		}
	}
	// Serialize first-start preparation and application updates per installation.
	unlock, err := installationLock(r.request.Root)
	if err != nil {
		return err
	}
	defer unlock()
	var progressErr error
	if r.request.Operation == "prepare" || r.request.Operation == "apply" {
		p.observeProgress = func(progress ComponentProgress) {
			if progressErr == nil {
				progressErr = writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "progress", Progress: &progress})
			}
		}
	}
	results, err := p.Prepare(r.request.Root, r.runtime, r.archive)
	if err != nil {
		return err
	}
	if progressErr != nil {
		return fmt.Errorf("component progress channel failed: %w", progressErr)
	}
	if r.request.Operation == "apply" {
		if err = writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "progress", Stage: updateInstalling}); err != nil {
			return err
		}
		updater := joinPath(r.request.Root, "Update.exe")
		if err = checkLineage(updater); err != nil {
			return err
		}
		// Main exit was established with its original handle above. Passing its
		// old PID again here could wait on a different process after PID reuse.
		if err = updaterJob.Run(updater, []string{"apply", "--rootDir", r.request.Root, "--packageDir", joinPath(r.request.Root, "packages"), "--package", r.request.PackagePath, "--norestart"}); err != nil {
			return err
		}
	}
	version := p.PackVersion
	if r.request.Operation == "apply" {
		version = r.release.PackVersion
		actualVersion, versionErr := installedVersion(r.request.Root)
		if versionErr != nil || actualVersion != version {
			return errors.Join(versionErr, errors.New("updated installation differs before tool admission"))
		}
	}
	if p.observeProgress != nil {
		p.observeProgress(ComponentProgress{Kind: "application", Phase: "publishing"})
	}
	if err = p.admitApplicationTools(r.request.Root, r.runtime, version); err != nil {
		return err
	}
	if progressErr != nil {
		return fmt.Errorf("component progress channel failed: %w", progressErr)
	}
	return writeWorkerStatus(statusFile, workerStatus{Nonce: nonce, Event: "complete", Components: results, PrincipalSID: p.toolAdmission.principal, Timings: timings})
}

func closeFiles(files []*os.File) {
	for i := len(files) - 1; i >= 0; i-- {
		files[i].Close()
	}
}

func inside(root, filename string) bool {
	relative, err := filepath.Rel(root, filename)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

var ErrCancelled = errors.New("UAC cancelled")

type workerProcess interface {
	Done() (bool, error)
	Wait(time.Duration) (uint32, error)
	Terminate() error
	Close() error
}
type processWaiter interface {
	Wait(time.Duration) error
	Alive() bool
	Close() error
}
type updateJob interface {
	Terminate() error
	Wait(time.Duration) error
	Close() error
}

type updaterInvocation interface {
	Admit() error
	Run(string, []string) error
	Close() error
}

// Poll only the existing nonce-bound channel. Progress cannot authorize or complete a handoff.
func waitWorkerProgress(worker workerProcess, file *os.File, nonce string, observe bool, timeout time.Duration, report func(ComponentProgress)) (uint32, error) {
	if !observe {
		return worker.Wait(timeout)
	}
	type result struct {
		code uint32
		err  error
	}
	finished := make(chan result, 1)
	go func() { code, err := worker.Wait(timeout); finished <- result{code, err} }()
	ticker := time.NewTicker(progressInterval)
	defer ticker.Stop()
	var previous ComponentProgress
	var previousStage string
	for {
		select {
		case done := <-finished:
			return done.code, done.err
		case <-ticker.C:
			state, err := readWorkerStatus(file, nonce)
			// Keep update-only stages private; public component progress stays unchanged.
			if err == nil && state.Event == "progress" && state.Stage == updateInstalling && state.Stage != previousStage {
				previousStage = state.Stage
				if report != nil {
					report(ComponentProgress{Kind: "application", Phase: updateInstalling})
				}
			}
			if err == nil && state.Event == "progress" && state.Progress != nil && *state.Progress != previous {
				previous = *state.Progress
				emit(Event{Event: "progress", Progress: state.Progress})
				if report != nil {
					report(*state.Progress)
				}
			}
		}
	}
}
