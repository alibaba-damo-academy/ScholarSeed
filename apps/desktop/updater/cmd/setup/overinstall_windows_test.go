package main

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Real Windows pipe/Go/Node interoperability; this is a transport contract,
// not installed-product or signed-update acceptance.
func TestSetupPipeHandshakeWithDesktopTransport(t *testing.T) {
	node, err := exec.LookPath("node.exe")
	if err != nil {
		t.Fatal(err)
	}
	module, err := filepath.Abs("../../../src/main/overinstall.ts")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(module); err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []string{"ready", "cancelled", "failed"} {
		t.Run(outcome, func(t *testing.T) {
			root := t.TempDir()
			runtime := filepath.Join(root, "runtime")
			if err := os.Mkdir(runtime, 0700); err != nil {
				t.Fatal(err)
			}
			bytes, err := os.ReadFile(node)
			if err != nil {
				t.Fatal(err)
			}
			executable := filepath.Join(runtime, "node.exe")
			if err := os.WriteFile(executable, bytes, 0700); err != nil {
				t.Fatal(err)
			}
			code := `const {pathToFileURL}=require('node:url');
(async()=>{
 const {listenForSetupExit,setupExitPipe}=await import(pathToFileURL(process.argv[1]));
 const outcome=process.argv[3];
 const server=await listenForSetupExit(setupExitPipe(process.argv[2]),{
 confirm:async()=>outcome!=='cancelled',prepare:async()=>{if(outcome==='failed')throw Error('refused')},
 recover:async()=>{},exit:()=>server.close(),failed:()=>{}
 }); console.log('listening');
})().catch(e=>{console.error(e);process.exit(1)});`
			command := exec.Command(executable, "--experimental-transform-types", "-e", code, module, root, outcome)
			output, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			command.Stderr = os.Stderr
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
			ready := make(chan error, 1)
			go func() { _, err := bufio.NewReader(output).ReadString('\n'); ready <- err }()
			select {
			case err := <-ready:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("pipe server did not start")
			}
			supported, err := requestInstallationExit(root)
			if !supported {
				t.Fatal("cooperative client was treated as legacy")
			}
			switch outcome {
			case "ready":
				if err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				if !errors.Is(err, errSetupCancelled) {
					t.Fatal(err)
				}
			case "failed":
				if !errors.Is(err, errSetupBusy) {
					t.Fatal(err)
				}
			}
		})
	}
}
