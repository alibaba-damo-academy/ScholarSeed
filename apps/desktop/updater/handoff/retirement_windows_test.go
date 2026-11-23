package handoff

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"
)

func TestRetirementProcess(t *testing.T) {
	if code := os.Getenv("SCHOLARSEED_RETIREMENT_TEST_EXIT"); code != "" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		value, _ := strconv.Atoi(code)
		os.Exit(value)
	}
}

func TestRetirementExitBarrier(t *testing.T) {
	for _, scenario := range []string{"success", "pending", "unknown", "failed"} {
		t.Run(scenario, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "书深 with spaces")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			image := filepath.Join(root, "Update.exe")
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			executable, err := os.ReadFile(self)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(image, executable, 0700); err != nil {
				t.Fatal(err)
			}
			if scenario == "unknown" {
				if err := os.WriteFile(filepath.Join(root, "user.txt"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			parent := exec.Command(image, "-test.run=^TestRetirementProcess$")
			parent.Dir = root
			if scenario == "pending" {
				parent = exec.Command(self, "-test.run=^TestRetirementProcess$")
			}
			code := "0"
			if scenario == "failed" {
				code = "7"
			}
			parent.Env = append(os.Environ(), "SCHOLARSEED_RETIREMENT_TEST_EXIT="+code)
			input, err := parent.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = parent.Start(); err != nil {
				t.Fatal(err)
			}
			defer parent.Process.Kill()
			defer input.Close()
			process, err := openProcessWaiter(uint32(parent.Process.Pid))
			if err != nil {
				t.Fatal(err)
			}
			defer process.Close()
			worker, err := startRetirement(root, process.(*windowsWaiter).handle)
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Process.Kill()
			if _, err = os.Stat(image); err != nil {
				t.Fatal("deleted before owner exited", err)
			}
			if err = os.Rename(root, root+"-swapped"); err == nil {
				t.Fatal("live retirement root could be swapped")
			}
			if scenario == "pending" {
				if err = os.Remove(image); err != nil {
					t.Fatal("official pending deletion", err)
				}
			}
			if err = input.Close(); err != nil {
				t.Fatal(err)
			}
			_ = parent.Wait()
			err = worker.Wait()
			if scenario == "success" || scenario == "pending" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err = os.Lstat(root); !os.IsNotExist(err) {
					t.Fatalf("root retained: %v", err)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe finalization reported success")
				}
				file := image
				if scenario == "unknown" {
					file = filepath.Join(root, "user.txt")
				}
				if _, err = os.Stat(file); err != nil {
					t.Fatal("protected residue changed", err)
				}
			}
		})
	}
}

// Faults replace a PowerShell function only inside this test's child process.
// The production script, process-exit barrier and native deletion checks still run.
func TestRetirementRootDeletionRetry(t *testing.T) {
	for _, scenario := range []string{"transient", "delayed", "unknown", "access", "sharing", "other", "image"} {
		t.Run(scenario, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "书深 with spaces")
			if err := os.Mkdir(root, 0700); err != nil {
				t.Fatal(err)
			}
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			image := filepath.Join(root, "Update.exe")
			raw, err := os.ReadFile(self)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(image, raw, 0700); err != nil {
				t.Fatal(err)
			}
			if scenario == "unknown" {
				if err = os.WriteFile(filepath.Join(root, "user.txt"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			parent := exec.Command(image, "-test.run=^TestRetirementProcess$")
			parent.Dir = root
			parent.Env = append(os.Environ(), "SCHOLARSEED_RETIREMENT_TEST_EXIT=0")
			input, err := parent.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			if err = parent.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if parent.ProcessState == nil {
					_ = parent.Process.Kill()
					_ = parent.Wait()
				}
			}()
			process, err := openProcessWaiter(uint32(parent.Process.Pid))
			if err != nil {
				t.Fatal(err)
			}
			defer process.Close()
			current, err := syscall.GetCurrentProcess()
			if err != nil {
				t.Fatal(err)
			}
			var inherited syscall.Handle
			if err = syscall.DuplicateHandle(current, process.(*windowsWaiter).handle, current, &inherited, 0, true, syscall.DUPLICATE_SAME_ACCESS); err != nil {
				t.Fatal(err)
			}
			defer syscall.CloseHandle(inherited)
			script := retirementScript + fmt.Sprintf(`
$script:originalRemove = ${function:Remove-Pinned}
$script:rootHandle = [IntPtr]::Zero
$script:rootPath = ''
$script:rootCalls = 0
function Remove-Pinned([IntPtr]$handle, [string]$expected, [bool]$directory) {
    $kind = 'image'
    if ($directory) {
        $kind = 'root'
        $script:rootCalls++
        if ($script:rootCalls -eq 1) {
            $script:rootHandle = $handle
            $script:rootPath = $expected
        } elseif ($handle -ne $script:rootHandle -or $expected -cne $script:rootPath) {
            throw 'retry changed the pinned root'
        }
    }
    [Console]::Out.WriteLine($kind)
    [Console]::Out.Flush()
    $code = 0
    if (!$directory -and '%[1]s' -eq 'image') { $code = 145 }
    if ($directory) {
        if ('%[1]s' -eq 'transient' -and $script:rootCalls -le 2) { $code = 145 }
        if ('%[1]s' -eq 'delayed' -and $script:rootCalls -le 8) { $code = 145 }
        if ('%[1]s' -eq 'access') { $code = 5 }
        if ('%[1]s' -eq 'sharing') { $code = 32 }
        if ('%[1]s' -eq 'other') { $code = 87 }
    }
    if ($code) { throw [ComponentModel.Win32Exception]::new($code, 'injected deletion refusal') }
    & $script:originalRemove $handle $expected $directory
}
$root = $native::CreateFileW($env:SCHOLARSEED_RETIREMENT_FAULT_ROOT, 0x80, 3, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
$image = $native::CreateFileW("$env:SCHOLARSEED_RETIREMENT_FAULT_ROOT\Update.exe", 0x80, 3, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
if ($root -eq [IntPtr]::new(-1) -or $image -eq [IntPtr]::new(-1)) { throw 'fault fixture could not pin its objects' }
Invoke-Retirement %[2]d $image $root %[3]d
`, scenario, inherited, retirementWait/time.Millisecond)
			worker := retirementTestScript(t, script, root)
			worker.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, AdditionalInheritedHandles: []syscall.Handle{inherited}}
			var diagnostics bytes.Buffer
			worker.Stderr = &diagnostics
			output, err := worker.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = worker.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if worker.ProcessState == nil {
					_ = worker.Process.Kill()
					_ = worker.Wait()
				}
			}()
			reader := bufio.NewReader(output)
			ready := make(chan error, 1)
			go func() {
				line, readErr := reader.ReadString('\n')
				if readErr == nil && strings.TrimSpace(line) != "ready" {
					readErr = fmt.Errorf("unexpected readiness %q", line)
				}
				ready <- readErr
			}()
			select {
			case err = <-ready:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(retirementStartup):
				t.Fatal("fault fixture startup timeout")
			}
			if err = input.Close(); err != nil {
				t.Fatal(err)
			}
			if err = parent.Wait(); err != nil {
				t.Fatal("fault fixture parent failed", err)
			}
			calls, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			workerErr := worker.Wait()
			images, roots := 0, 0
			for _, line := range strings.Fields(string(calls)) {
				switch line {
				case "image":
					images++
				case "root":
					roots++
				default:
					t.Fatalf("unexpected fault output: %q", calls)
				}
			}
			if images != 1 {
				t.Fatalf("image deletion retried: %d; %s", images, diagnostics.String())
			}
			if scenario == "transient" || scenario == "delayed" {
				minimum := 3
				if scenario == "delayed" {
					minimum = 9
				}
				if workerErr != nil || roots < minimum || roots > 80 {
					t.Fatalf("bounded root refusal not recovered: calls=%d err=%v %s", roots, workerErr, diagnostics.String())
				}
				if _, err = os.Lstat(root); !os.IsNotExist(err) {
					t.Fatalf("root retained: %v", err)
				}
				return
			}
			if workerErr == nil {
				t.Fatal("unsafe deletion reported success")
			}
			wanted := 1
			if scenario == "image" {
				wanted = 0
				if kept, readErr := os.ReadFile(image); readErr != nil || !bytes.Equal(kept, raw) {
					t.Fatal("refused image changed", readErr)
				}
			}
			if scenario == "unknown" {
				if kept, readErr := os.ReadFile(filepath.Join(root, "user.txt")); readErr != nil || string(kept) != "keep" {
					t.Fatal("unknown member changed", readErr)
				}
				if roots < 1 || roots > 80 {
					t.Fatalf("unbounded unknown-member refusal: %d", roots)
				}
				return
			}
			if roots != wanted {
				t.Fatalf("unexpected root deletion attempts: %d want %d; %s", roots, wanted, diagnostics.String())
			}
		})
	}
}

func retirementTestScript(t *testing.T, script, root string) *exec.Cmd {
	t.Helper()
	words := utf16.Encode([]rune(script))
	raw := make([]byte, len(words)*2)
	for index, word := range words {
		raw[index*2], raw[index*2+1] = byte(word), byte(word>>8)
	}
	system := filepath.Join(os.Getenv("SystemRoot"), "System32")
	command := exec.Command(filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
	command.Dir = system
	command.Env = []string{"SystemRoot=" + filepath.Dir(system), "WINDIR=" + filepath.Dir(system), "PATH=" + system, "PSModulePath=" + filepath.Join(system, "WindowsPowerShell", "v1.0", "Modules"), "SCHOLARSEED_RETIREMENT_FAULT_ROOT=" + root}
	retirementAssertCommandLine(t, command.Args)
	// Check every appended fixture, as well as production, with a long quoted
	// executable path. The actual child still uses the real system executable.
	worst := append([]string(nil), command.Args...)
	const prefix, suffix = `C:\system `, `\powershell.exe`
	worst[0] = prefix + strings.Repeat("a", 259-len(prefix)-len(suffix)) + suffix
	retirementAssertCommandLine(t, worst)
	return command
}

func retirementAssertCommandLine(t *testing.T, args []string) {
	t.Helper()
	const limit = 32767 // CreateProcessW includes the UTF-16 terminating NUL.
	var escaped []string
	for _, arg := range args {
		escaped = append(escaped, syscall.EscapeArg(arg))
	}
	units := len(utf16.Encode([]rune(strings.Join(escaped, " ")))) + 1
	if units > limit {
		t.Fatalf("retirement command exceeds CreateProcessW limit: %d > %d", units, limit)
	}
	t.Logf("retirement command UTF-16 units including NUL: %d", units)
}

func TestRetirementCommandLineBudget(t *testing.T) {
	const largestHandle = ^uint64(0)
	script := retirementScript + fmt.Sprintf("\nInvoke-Retirement %d %d %d %d\n", largestHandle, largestHandle, largestHandle, retirementWait/time.Millisecond)
	_ = retirementTestScript(t, script, "")
}

func TestRetirementDispositionCapture(t *testing.T) {
	for _, scenario := range []string{"invalid-handle", "nonempty", "access", "true-stale", "false-zero"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "keep.txt"), []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			script := retirementScript + `
if (!$native.GetMethod('Disposition')) { throw 'disposition capture missing' }
$flag = [Attribute]::GetCustomAttribute($native.GetMethod('SetFileInformationByHandle'), [Runtime.InteropServices.DllImportAttribute])
if (!$flag.SetLastError) { throw 'disposition error caching disabled' }
`
			if scenario == "true-stale" || scenario == "false-zero" {
				// This proxy exists only in this test's PowerShell child. Real object
				// checks forward to the production imports; only the disposition
				// result is controlled to cover BOOL/error combinations reliably.
				result, code := 1, 145
				if scenario == "false-zero" {
					result, code = 0, 0
				}
				script += fmt.Sprintf(`
$original = $native
$proxy = $module.DefineType('DispositionResultFixture', 'Public, Sealed, Abstract')
foreach ($name in @('GetFileInformationByHandleEx', 'GetFinalPathNameByHandleW')) {
    $target = $original.GetMethod($name)
    $parameters = [Type[]]@($target.GetParameters() | ForEach-Object { $_.ParameterType })
    $forward = $proxy.DefineMethod($name, 'Public, Static', $target.ReturnType, $parameters)
    $emit = $forward.GetILGenerator()
    for ($i = 0; $i -lt $parameters.Length; $i++) { $emit.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]$i) }
    $emit.Emit([Reflection.Emit.OpCodes]::Call, $target)
    $emit.Emit([Reflection.Emit.OpCodes]::Ret)
}
$fixture = $proxy.DefineMethod('Disposition', 'Public, Static', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32], [int].MakeByRefType()))
$emit = $fixture.GetILGenerator()
$emit.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]4)
$emit.Emit([Reflection.Emit.OpCodes]::Ldc_I4, [int]%[1]d)
$emit.Emit([Reflection.Emit.OpCodes]::Stind_I4)
$emit.Emit([Reflection.Emit.OpCodes]::Ldc_I4, [int]%[2]d)
$emit.Emit([Reflection.Emit.OpCodes]::Ret)
$native = $proxy.CreateType()
$handle = $original::CreateFileW("$env:SCHOLARSEED_RETIREMENT_FAULT_ROOT\keep.txt", 0x80, 7, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::new(-1)) { throw 'consumer fixture open failed' }
try {
    $refused = $false
    try { Remove-Pinned $handle (Handle-Path $handle) $false }
    catch [ComponentModel.Win32Exception] {
        $refused = $true
        if ($_.Exception.NativeErrorCode -ne 0 -or %[2]d -ne 0) { throw }
    }
    if ($refused -ne (%[2]d -eq 0)) { throw 'native BOOL was confused with its error code' }
} finally { [void]$original::CloseHandle($handle) }
`, code, result)
			} else {
				script += fmt.Sprintf(`
$handle = [IntPtr]::new(-1)
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(1)
try {
    [Runtime.InteropServices.Marshal]::WriteByte($buffer, 0, 1)
    $wanted = 6
    $directory = '%[1]s' -eq 'nonempty'
    if ($directory) {
        $wanted = 145
        $handle = $native::CreateFileW($env:SCHOLARSEED_RETIREMENT_FAULT_ROOT, 0x10080, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
    } elseif ('%[1]s' -eq 'access') {
        $wanted = 5
        $handle = $native::CreateFileW("$env:SCHOLARSEED_RETIREMENT_FAULT_ROOT\keep.txt", 0x80, 7, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
    }
    if ('%[1]s' -ne 'invalid-handle' -and $handle -eq [IntPtr]::new(-1)) { throw 'native fixture open failed' }
    [int]$code = 0
    $ok = $native::Disposition($handle, 4, $buffer, 1, [ref]$code)
    if ($ok -or $code -ne $wanted) { throw "native failure capture mismatch: success=$ok code=$code wanted=$wanted" }
    if ('%[1]s' -ne 'invalid-handle') {
        $refused = $false
        try { Remove-Pinned $handle (Handle-Path $handle) $directory }
        catch [ComponentModel.Win32Exception] {
            $refused = $true
            if ($_.Exception.NativeErrorCode -ne $wanted) { throw }
            if (!$_.Exception.Message.Contains("Win32=$wanted") -or !$_.Exception.Message.Contains("directory=$directory")) { throw 'native diagnostic context missing' }
        }
        if (!$refused) { throw 'native deletion refusal was lost' }
    }
} finally {
    if ($handle -ne [IntPtr]::new(-1)) { [void]$native::CloseHandle($handle) }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
}
`, scenario)
			}
			script += "\n[Console]::Out.WriteLine('capture-passed')\n"
			output, err := retirementTestScript(t, script, root).CombinedOutput()
			if err != nil || strings.TrimSpace(string(output)) != "capture-passed" {
				t.Fatalf("retirement disposition capture failed: %v %s", err, output)
			}
			if raw, err := os.ReadFile(filepath.Join(root, "keep.txt")); err != nil || string(raw) != "keep" {
				t.Fatal("capture fixture member changed", err)
			}
		})
	}
}

func TestRetirementRootDeletionBudget(t *testing.T) {
	for _, scenario := range []string{"expired", "local-cap", "oversleep"} {
		t.Run(scenario, func(t *testing.T) {
			script := retirementScript + fmt.Sprintf(`
if (!(Get-Command Remove-EmptyRoot -CommandType Function -ErrorAction SilentlyContinue)) { throw 'root deletion helper missing' }
$script:calls = 0
function Remove-Pinned([IntPtr]$handle, [string]$expected, [bool]$directory) {
    $script:calls++
    if ('%[1]s' -eq 'local-cap') { [Threading.Thread]::Sleep(2010) }
    throw [ComponentModel.Win32Exception]::new(145, 'injected root refusal')
}
if ('%[1]s' -eq 'oversleep') {
    function Start-Sleep([int]$Milliseconds) { [Threading.Thread]::Sleep(2010) }
}
$clock = [Diagnostics.Stopwatch]::StartNew()
$timeout = %[2]d
$wanted = 1
if ('%[1]s' -eq 'expired') { $timeout = 0; $wanted = 0 }
$refused = $false
try { Remove-EmptyRoot ([IntPtr]::new(123)) 'unused fixture path' $clock $timeout }
catch {
    $refused = $true
    if ($wanted -eq 1 -and
        ($_.Exception -isnot [ComponentModel.Win32Exception] -or $_.Exception.NativeErrorCode -ne 145)) { throw }
}
if (!$refused -or $script:calls -ne $wanted) { throw "deletion budget renewed: calls=$script:calls" }
[Console]::Out.WriteLine('budget-guarded')
`, scenario, retirementWait/time.Millisecond)
			output, err := retirementTestScript(t, script, "").CombinedOutput()
			if err != nil || strings.TrimSpace(string(output)) != "budget-guarded" {
				t.Fatalf("retirement budget failed: %v %s", err, output)
			}
		})
	}
}

func TestRetirementRejectsHardlinkedImage(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(root, "Update.exe")); err != nil {
		t.Fatal(err)
	}
	process, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	if _, err = startRetirement(root, process.(*windowsWaiter).handle); err == nil {
		t.Fatal("hardlink accepted")
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "keep" {
		t.Fatal("outside changed", err)
	}
}

func TestRetirementRejectsUnrelatedParent(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := prepareRetirement(filepath.Join(root, "current")); err == nil {
		t.Fatal("unrelated parent accepted")
	}
}

func TestRetirementRejectsJunctions(t *testing.T) {
	for _, position := range []string{"root", "ancestor"} {
		t.Run(position, func(t *testing.T) {
			outside := t.TempDir()
			root := outside
			if position == "ancestor" {
				root = filepath.Join(outside, "install")
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
			}
			image := filepath.Join(root, "Update.exe")
			if err := os.WriteFile(image, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(t.TempDir(), "redirect")
			if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
				t.Fatalf("junction setup: %v %s", err, output)
			}
			defer os.Remove(link)
			target := link
			if position == "ancestor" {
				target = filepath.Join(link, "install")
			}
			process, err := openProcessWaiter(uint32(os.Getpid()))
			if err != nil {
				t.Fatal(err)
			}
			defer process.Close()
			if _, err = startRetirement(target, process.(*windowsWaiter).handle); err == nil {
				t.Fatal("junction accepted")
			}
			if raw, err := os.ReadFile(image); err != nil || string(raw) != "preserve" {
				t.Fatal("outside changed", err)
			}
		})
	}
}
