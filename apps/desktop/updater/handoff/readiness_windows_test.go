//go:build windows

package handoff

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestInspectionIsReadOnlyForReadyMissingAndInvalidState(t *testing.T) {
	p, manifest, root, files := applicationFixture(t)
	c := manifest.Components[0]
	dir, err := componentDirectory(root, c)
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(dir, filepath.FromSlash(c.Entry))
	if err = os.MkdirAll(filepath.Dir(entry), 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(entry, []byte("verified python"), 0644); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(componentReceipt(p, c))
	receipt := filepath.Join(dir, ReceiptName)
	if err = os.WriteFile(receipt, raw, 0600); err != nil {
		t.Fatal(err)
	}
	r := &prepared{request: Request{Root: root}, runtime: manifest, admission: p.toolAdmission}
	before := applicationSnapshot(t, p.toolAdmission, files[0])
	check := func(want bool, wantErr bool) {
		t.Helper()
		got, e := p.inspectRuntime(r, nil)
		if got != want || (e != nil) != wantErr {
			t.Fatalf("inspect=%v %v, want %v error=%v", got, e, want, wantErr)
		}
	}
	check(false, false) // No application admission; inspection must not publish one.
	appReceipt := joinPath(root, "runtime/"+applicationReceiptPrefix+p.PackVersion+".json")
	if _, err = os.Stat(appReceipt); !os.IsNotExist(err) {
		t.Fatal("inspect published admission")
	}
	if after := applicationSnapshot(t, p.toolAdmission, files[0]); !reflect.DeepEqual(before, after) {
		t.Fatal("inspect changed permissions")
	}
	if err = p.admitApplicationTools(root, manifest, p.PackVersion); err != nil {
		t.Fatal(err)
	}
	check(true, false)
	if err = os.WriteFile(receipt, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	check(false, true)
	after, _ := os.ReadFile(receipt)
	if string(after) != "{}" {
		t.Fatal("inspect repaired invalid receipt")
	}
	if err = os.WriteFile(receipt, raw, 0600); err != nil {
		t.Fatal(err)
	}
	r.runtime.Components = append([]Component(nil), manifest.Components...)
	r.runtime.Components[0].Version = "missing-r1"
	check(false, false)
	if _, err = os.Stat(filepath.Join(root, "runtime", c.Kind, "missing-r1")); !os.IsNotExist(err) {
		t.Fatal("inspect prepared missing component")
	}
}
