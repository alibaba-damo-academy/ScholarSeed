package handoff

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

func TestNativePaintLayout(t *testing.T) {
	var p visualPaint
	if unsafe.Sizeof(p) != 72 || unsafe.Offsetof(p.Rect) != 12 {
		t.Fatal("invalid Win64 PAINTSTRUCT")
	}
	if unsafe.Sizeof(bitmapHeader{}) != 40 {
		t.Fatal("invalid bitmap header")
	}
}

func TestNativeCommittedRecoveryDefersNotice(t *testing.T) {
	if os.Getenv("SCHOLARSEED_NATIVE_UI_INTEGRATION") != "1" {
		t.Skip("requires interactive Windows desktop")
	}
	for _, exited := range []bool{true, false} {
		failure := &UpdateRecoveryError{ProcessesExited: exited, Cause: errors.New("controlled interruption")}
		_, err := runProgressWindow(testUpdateMessages()["en"].StartupMessages, func(context.Context, func(BootstrapProgress)) (BootstrapResult, error) {
			time.Sleep(500 * time.Millisecond)
			return BootstrapResult{}, failure
		}, true)
		if !errors.Is(err, failure) {
			t.Fatal("progress window did not return the original recovery outcome")
		}
	}
}

func TestNativeCommittedUpdateCloseDoesNotCancelOrRetry(t *testing.T) {
	if os.Getenv("SCHOLARSEED_NATIVE_UI_INTEGRATION") != "1" {
		t.Skip("requires interactive Windows desktop")
	}
	text := testUpdateMessages()["en"]
	text.Title = "ScholarSeed committed update integration"
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var calls atomic.Int32
	var resumed atomic.Bool
	checked := make(chan error, 1)
	go func() {
		deadline := time.Now().Add(10 * time.Second)
		var window uintptr
		for time.Now().Before(deadline) {
			window, _, _ = user.NewProc("FindWindowW").Call(0, uintptr(unsafe.Pointer(nativeText(text.Title))))
			if window != 0 {
				shown, _, _ := user.NewProc("IsWindowVisible").Call(window)
				if shown != 0 {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		shown, _, _ := user.NewProc("IsWindowVisible").Call(window)
		if window == 0 || shown == 0 {
			unblock()
			checked <- errors.New("update progress window missing")
			return
		}
		defer func() {
			unblock()
			// A close while work is pending must be ignored. Drain the owner
			// before closing the failure UI, including assertion-failure paths.
			for time.Now().Before(deadline) {
				visible, _, _ := user.NewProc("IsWindowVisible").Call(item(window, idCancel))
				if visible != 0 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			user.NewProc("PostMessageW").Call(window, wmClose, 0, 0)
		}()
		user.NewProc("SendMessageW").Call(window, wmClose, 0, 0)
		visible, _, _ := user.NewProc("IsWindowVisible").Call(window)
		if visible == 0 {
			checked <- errors.New("close hid committed update progress")
			return
		}
		user.NewProc("SendMessageW").Call(window, wmCommand, idRetry, 0)
		if calls.Load() != 1 {
			checked <- errors.New("committed operation retried")
			return
		}
		unblock()
		visibleControl := func(id int) bool { v, _, _ := user.NewProc("IsWindowVisible").Call(item(window, id)); return v != 0 }
		for !visibleControl(idDetail) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if visibleControl(idRetry) || !visibleControl(idCancel) || !visibleControl(idDetail) {
			checked <- errors.New("committed failure must offer exit without retry")
			return
		}
		// Longer than transfer.ts's helper replacement budget. Recovery must
		// not start while the user is reading the failure notice.
		if os.Getenv("SCHOLARSEED_TEST_RECOVERED_STARTUP") != "" {
			time.Sleep(5500 * time.Millisecond)
			if resumed.Load() {
				checked <- errors.New("recovery started before failure notice closed")
				return
			}
		}
		checked <- nil
	}()
	work := func(ctx context.Context, observe func(BootstrapProgress)) (BootstrapResult, error) {
		calls.Add(1)
		observe(text.progress(ComponentProgress{Kind: "texlive", Phase: "extracting", Bytes: 50, TotalBytes: 100, Files: 1, TotalFiles: 2}))
		select {
		case <-ctx.Done():
			return BootstrapResult{}, errors.New("presentation cancelled committed work")
		case <-release:
		}
		return BootstrapResult{}, errors.New("controlled update failure")
	}
	var workContext context.Context
	err := presentUpdate(func(observe func(ComponentProgress)) (func() error, error) {
		_, outcome := work(workContext, func(progress BootstrapProgress) {
			observe(ComponentProgress{Kind: "texlive", Phase: "extracting", Bytes: progress.Received, TotalBytes: progress.Total})
		})
		return func() error {
			window, _, _ := user.NewProc("FindWindowW").Call(0, uintptr(unsafe.Pointer(nativeText(text.Title))))
			if window != 0 {
				t.Error("recovery started before the native dialog was destroyed")
			}
			resumed.Store(true)
			if script := os.Getenv("SCHOLARSEED_TEST_RECOVERED_STARTUP"); script != "" {
				node, err := exec.LookPath("node")
				if err != nil {
					return err
				}
				_, err = restart(node, []string{"--experimental-transform-types", script})
				return err
			}
			return nil
		}, outcome
	}, func(run func(func(ComponentProgress)) error) error {
		_, outcome := runProgressWindow(text.StartupMessages, func(ctx context.Context, observe func(BootstrapProgress)) (BootstrapResult, error) {
			workContext = ctx
			return BootstrapResult{}, run(func(event ComponentProgress) { observe(text.progress(event)) })
		}, true)
		return outcome
	})
	if e := <-checked; e != nil {
		t.Fatal(e)
	}
	if err == nil || err.Error() != "controlled update failure" || calls.Load() != 1 || !resumed.Load() {
		t.Fatalf("update lifecycle: calls=%d err=%v", calls.Load(), err)
	}
}

// Exercise the actual detached/windowsHide/pipe launch and the real TypeScript
// helper-copy transport. This remains isolated native integration, not a signed
// installed update or full Electron startup acceptance test.
func TestNativeHiddenStartupAndFailureRecovery(t *testing.T) {
	if os.Getenv("SCHOLARSEED_NATIVE_UI_INTEGRATION") != "1" {
		t.Skip("requires interactive Windows desktop")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	producer, err := filepath.Abs("../../src/main/transfer.ts")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	cmd := exec.Command("node", "--experimental-transform-types", "--input-type=module", "-e", nativeStartupDriver, executable, producer, directory)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("hidden startup/recovery: %v\n%s", err, output)
	}
	t.Log(string(output))
}

const nativeStartupDriver = `
import {spawn} from 'node:child_process';
import {mkdir,copyFile,writeFile,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
const [exe,producer,root]=process.argv.slice(1);
const local=join(root,'profile'), cache=join(local,'ScholarSeedUpdates');
const app=join(root,'installation','current'), helper=join(cache,'handoff.exe');
await mkdir(cache,{recursive:true});
await mkdir(join(app,'resources','handoff'),{recursive:true});
await copyFile(exe,helper);
await copyFile(exe,join(app,'resources','handoff','handoff.exe'));
const result=join(root,'recovery.json'), script=join(root,'recovery.mjs');
await writeFile(script,` + "`" + `
import {prepareWindowsTransfer} from ${JSON.stringify(new URL('file:///'+producer.replaceAll('\\','/')).href)};
import {writeFile} from 'node:fs/promises';
let timing;
try {
  await prepareWindowsTransfer({operation:'inspect',application:${JSON.stringify(app)},log(line){
    if(line.startsWith('[component-timing]')) timing=JSON.parse(line.slice('[component-timing]'.length));
  }});
  throw new Error('test executable unexpectedly spoke handoff protocol');
} catch(error) {
  // The isolated test EXE rejects --request. Reaching ready proves the real
  // transport replaced and spawned the fixed helper, without fake protocol events.
  await writeFile(${JSON.stringify(result)},JSON.stringify({message:String(error),timing}));
}
` + "`" + `);
for (const windowsHide of [false,true]) {
  const child=spawn(helper,['-test.run=^TestNativeCommittedUpdateCloseDoesNotCancelOrRetry$','-test.timeout=25s','-test.v'],{
    cwd:process.cwd(),detached:true,windowsHide,stdio:['pipe','pipe','pipe'],
    env:{...process.env,LOCALAPPDATA:local,SCHOLARSEED_TEST_RECOVERED_STARTUP:script}
  });
  let output=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  if(code!==0) throw new Error('child exit '+code+' '+output);
  let recovered;
  for(let n=0;n<100;n++) {try { recovered=JSON.parse(await readFile(result,'utf8'));break; }catch{} await new Promise(r=>setTimeout(r,100));}
  if(recovered?.timing?.metrics?.copy?.calls!==1 || recovered?.timing?.metrics?.spawn?.calls!==1 || recovered?.timing?.last_phase!=='ready')
    throw new Error('recovery helper replacement/startup failed '+JSON.stringify(recovered));
  console.log(JSON.stringify({windowsHide,code,recovered}));
  await unlink(result);
}
`

// Exercises actual Win32 controls and owner cancellation. This is integration
// coverage, separate from cold-download screenshots of the product launcher.
func TestNativeRetryAndCancel(t *testing.T) {
	if os.Getenv("SCHOLARSEED_NATIVE_UI_INTEGRATION") != "1" {
		t.Skip("requires interactive Windows desktop")
	}
	text := StartupMessages{Title: "ScholarSeed native integration", Brand: "ScholarSeed", Elapsed: "Waiting:", Preparing: "Preparing", Verifying: "Verifying", Downloading: "Downloading {{name}}: {{percent}}%", Failed: "Failed", Retry: "Retry", Exit: "Exit", Stopping: "Stopping", Cancel: "Cancel"}
	var calls atomic.Int32
	var cancelled atomic.Bool
	finished := make(chan error, 1)
	go func() {
		deadline := time.Now().Add(10 * time.Second)
		var window uintptr
		for time.Now().Before(deadline) {
			window, _, _ = user.NewProc("FindWindowW").Call(0, uintptr(unsafe.Pointer(nativeText(text.Title))))
			if window != 0 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if window == 0 {
			finished <- errors.New("dialog missing")
			return
		}
		defer user.NewProc("PostMessageW").Call(window, wmClose, 0, 0)
		visibleControl := func(id int) bool { v, _, _ := user.NewProc("IsWindowVisible").Call(item(window, id)); return v != 0 }
		for !visibleControl(idRetry) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if !visibleControl(idRetry) || !visibleControl(idDetail) || !visibleControl(idCancel) {
			finished <- errors.New("failure actions missing")
			return
		}
		user.NewProc("PostMessageW").Call(window, wmCommand, idRetry, 0)
		for (calls.Load() != 2 || visibleControl(idRetry)) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if calls.Load() != 2 || visibleControl(idRetry) || visibleControl(idDetail) || visibleControl(idCancel) || !visibleControl(idElapsed) {
			finished <- errors.New("retry did not restore compact progress")
			return
		}
		// Minimize and restore are presentation-only actions.
		user.NewProc("SendMessageW").Call(window, 0x0112, 0xf020, 0)
		iconic, _, _ := user.NewProc("IsIconic").Call(window)
		if iconic == 0 || cancelled.Load() {
			finished <- errors.New("minimize changed owner lifecycle")
			return
		}
		user.NewProc("SendMessageW").Call(window, 0x0112, 0xf120, 0)
		finished <- nil
	}()
	_, err := PrepareWindow(text, func(ctx context.Context, observe func(BootstrapProgress)) (BootstrapResult, error) {
		if calls.Add(1) == 1 {
			return BootstrapResult{}, errors.New("network unavailable")
		}
		observe(BootstrapProgress{Phase: BootstrapDownloading, Received: 48, Total: 100})
		<-ctx.Done()
		cancelled.Store(true)
		return BootstrapResult{}, ctx.Err()
	})
	if e := <-finished; e != nil {
		t.Fatal(e)
	}
	if !errors.Is(err, context.Canceled) || !cancelled.Load() {
		t.Fatalf("close failed to cancel and drain owner: %v", err)
	}
}
