//go:build windows

package handoff

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

func applicationFixture(t *testing.T) (Policy, Runtime, string, []string) {
	t.Helper()
	policy, manifest, _ := fixture(t)
	policy.toolAdmission = admissionFixture(t)
	component := manifest.Components[0]
	component.Kind = "electron"
	manifest.Components = []Component{component}
	root := t.TempDir()
	admissionPermissions(t, root, "D:P(A;OICI;FA;;;"+policy.toolAdmission.owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	roots, err := applicationRoots(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	var filenames []string
	for _, item := range roots {
		directory := filepath.Join(item.path, "nested")
		if err := os.MkdirAll(directory, 0755); err != nil {
			t.Fatal(err)
		}
		filename := filepath.Join(directory, "tool.dll")
		if err := os.WriteFile(filename, []byte("verified application bytes"), 0644); err != nil {
			t.Fatal(err)
		}
		filenames = append(filenames, filename)
	}
	return policy, manifest, root, filenames
}

func applicationSnapshot(t *testing.T, admission *toolAdmission, path string) applicationSecurity {
	t.Helper()
	handle, err := toolHandle(path, toolReadControl)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	snapshot, err := admission.applicationSecurity(handle)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestApplicationToolAdmissionExactGrantAndReuse(t *testing.T) {
	policy, manifest, root, filenames := applicationFixture(t)
	before := applicationSnapshot(t, policy.toolAdmission, filenames[0])
	ready, err := policy.applicationToolsReady(root, manifest, policy.PackVersion)
	if err != nil || ready {
		t.Fatalf("unexpected initial readiness %v %v", ready, err)
	}
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatal(err)
	}
	for _, filename := range filenames {
		after := applicationSnapshot(t, policy.toolAdmission, filename)
		if !applicationHasAccess(after, policy.toolAdmission.principal) || after.owner != before.owner || after.control != before.control {
			t.Fatalf("incorrect exact application grant %#v", after)
		}
		for key, mask := range before.entries {
			if after.entries[key] != mask {
				t.Fatal("unrelated permissions changed")
			}
		}
	}
	admissionPermissions(t, filenames[0], "D:P(D;;FRFX;;;"+policy.toolAdmission.principal+")(A;;FA;;;"+policy.toolAdmission.owner+")(A;;FA;;;SY)(A;;FA;;;BA)")
	ready, err = policy.applicationToolsReady(root, manifest, policy.PackVersion)
	if err != nil || !ready {
		t.Fatalf("bounded reuse scanned a descendant: %v %v", ready, err)
	}
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatalf("installation reuse scanned descendants: %v", err)
	}
}

func TestApplicationToolAdmissionPreflightRejectsWithoutMutation(t *testing.T) {
	for _, extra := range []string{
		"(D;;FRFX;;;",
		"(A;;FA;;;",
	} {
		t.Run(extra, func(t *testing.T) {
			policy, manifest, root, filenames := applicationFixture(t)
			before := applicationSnapshot(t, policy.toolAdmission, filenames[0])
			admissionPermissions(t, filenames[1], "D:P"+extra+policy.toolAdmission.principal+")(A;;FA;;;"+policy.toolAdmission.owner+")(A;;FA;;;SY)(A;;FA;;;BA)")
			if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err == nil {
				t.Fatal("accepted unsafe application tool permissions")
			}
			after := applicationSnapshot(t, policy.toolAdmission, filenames[0])
			if !reflect.DeepEqual(before, after) {
				t.Fatal("preflight failure partially changed another tool")
			}
			filename := joinPath(root, "runtime/"+applicationReceiptPrefix+policy.PackVersion+".json")
			if _, err := os.Stat(filename); !os.IsNotExist(err) {
				t.Fatal("failed preflight published completion receipt")
			}
		})
	}
}

func TestApplicationToolAdmissionRejectsLinksAndChangedRoots(t *testing.T) {
	policy, manifest, root, filenames := applicationFixture(t)
	if err := os.Link(filenames[0], filenames[0]+".alias"); err != nil {
		t.Fatal(err)
	}
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err == nil {
		t.Fatal("accepted multiply-linked application asset")
	}
	if err := os.Remove(filenames[0] + ".alias"); err != nil {
		t.Fatal(err)
	}
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatal(err)
	}
	roots, err := applicationRoots(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(roots[0].path, roots[0].path+".previous"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(roots[0].path, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := policy.applicationToolsReady(root, manifest, policy.PackVersion); err == nil {
		t.Fatal("accepted substituted application root")
	}
}

func TestApplicationToolAdmissionRejectsReceiptIdentityChanges(t *testing.T) {
	for _, field := range []string{"policy", "principalSID", "packVersion", "extra"} {
		t.Run(field, func(t *testing.T) {
			policy, manifest, root, _ := applicationFixture(t)
			if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
				t.Fatal(err)
			}
			filename := joinPath(root, "runtime/"+applicationReceiptPrefix+policy.PackVersion+".json")
			data, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			var record map[string]any
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatal(err)
			}
			record[field] = "modified"
			data, err = json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filename, data, 0644); err != nil {
				t.Fatal(err)
			}
			if _, err := policy.applicationToolsReady(root, manifest, policy.PackVersion); err == nil {
				t.Fatal("accepted changed admission receipt")
			}
		})
	}
}

func TestApplicationToolAdmissionGrantDoesNotPropagate(t *testing.T) {
	policy, _, _, filenames := applicationFixture(t)
	parent := filepath.Dir(filenames[0])
	beforeChild := applicationSnapshot(t, policy.toolAdmission, filenames[0])
	handle, err := toolHandle(parent, toolReadControl|applicationAttributeAccess)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	snapshot, err := policy.toolAdmission.applicationSecurity(handle)
	if err != nil {
		t.Fatal(err)
	}
	asset := applicationAsset{path: parent, handle: handle, security: snapshot}
	if err := policy.toolAdmission.grantApplicationAsset(asset); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(beforeChild, applicationSnapshot(t, policy.toolAdmission, filenames[0])) {
		t.Fatal("granting a pre-existing directory propagated permissions to its child")
	}
	if err := os.Rename(parent, parent+".replaced"); err == nil {
		t.Fatal("pinned application directory permitted replacement")
	}
}

func TestApplicationToolAdmissionRejectsConcurrentACLChange(t *testing.T) {
	policy, _, _, filenames := applicationFixture(t)
	handle, err := toolHandle(filenames[0], toolReadControl|applicationAttributeAccess)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)
	snapshot, err := policy.toolAdmission.applicationSecurity(handle)
	if err != nil {
		t.Fatal(err)
	}
	admissionPermissions(t, filenames[0], "D:P(A;;FA;;;"+policy.toolAdmission.owner+")(A;;FA;;;SY)(A;;FA;;;BA)")
	asset := applicationAsset{path: filenames[0], handle: handle, security: snapshot}
	if err := policy.toolAdmission.grantApplicationAsset(asset); err == nil {
		t.Fatal("grant accepted a changed preflight security snapshot")
	}
}

func TestApplicationToolAdmissionRejectsLostRootAccess(t *testing.T) {
	policy, manifest, root, _ := applicationFixture(t)
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatal(err)
	}
	roots, err := applicationRoots(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	admissionPermissions(t, roots[0].path, "D:P(A;OICI;FA;;;"+policy.toolAdmission.owner+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if _, err := policy.applicationToolsReady(root, manifest, policy.PackVersion); err == nil {
		t.Fatal("bounded reuse accepted a root that lost sandbox access")
	}
}

func TestApplicationToolAdmissionPreservesNonAssets(t *testing.T) {
	policy, manifest, root, _ := applicationFixture(t)
	filename := joinPath(root, "current/resources/not-a-tool.json")
	if err := os.WriteFile(filename, []byte("not a tool"), 0644); err != nil {
		t.Fatal(err)
	}
	before := applicationSnapshot(t, policy.toolAdmission, filename)
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, applicationSnapshot(t, policy.toolAdmission, filename)) {
		t.Fatal("tool admission changed an asset outside its fixed roots")
	}
}

func applicationInstalledFixture(t *testing.T) (Policy, Runtime, string, string) {
	t.Helper()
	policy, manifest, root, _ := applicationFixture(t)
	version := "<package><metadata><id>scholarseed</id><version>" + policy.PackVersion + "</version></metadata></package>"
	if err := os.WriteFile(joinPath(root, "current/sq.version"), []byte(version), 0644); err != nil {
		t.Fatal(err)
	}
	filename := joinPath(root, "runtime/"+applicationReceiptPrefix+policy.PackVersion+".json")
	return policy, manifest, root, filename
}

func TestApplicationToolAdmissionRetirementLifecycle(t *testing.T) {
	policy, manifest, root, filename := applicationInstalledFixture(t)
	if err := RetireApplicationTools(root); err != nil {
		t.Fatalf("missing completion record was not a no-op: %v", err)
	}
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatal(err)
	}
	component, err := componentDirectory(root, manifest.Components[0])
	if err != nil {
		t.Fatal(err)
	}
	heavyReceipt := filepath.Join(component, ReceiptName)
	if err := os.WriteFile(heavyReceipt, []byte("component completion must survive"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := RetireApplicationTools(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filename); !os.IsNotExist(err) {
		t.Fatal("retirement did not delete the application completion record")
	}
	if data, err := os.ReadFile(heavyReceipt); err != nil || string(data) != "component completion must survive" {
		t.Fatal("retirement changed a heavy component completion record")
	}
	if ready, err := policy.applicationToolsReady(root, manifest, policy.PackVersion); err != nil || ready {
		t.Fatalf("retired completion remained ready: %v %v", ready, err)
	}
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatalf("re-admission after reinstall retirement failed: %v", err)
	}
}

func TestApplicationToolAdmissionRetirementRejectsInvalidRecord(t *testing.T) {
	for _, field := range []string{"principalSID", "packVersion", "policy", "extra"} {
		t.Run(field, func(t *testing.T) {
			policy, manifest, root, filename := applicationInstalledFixture(t)
			if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			var record map[string]any
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatal(err)
			}
			record[field] = "invalid"
			data, err = json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filename, data, 0644); err != nil {
				t.Fatal(err)
			}
			if err := RetireApplicationTools(root); err == nil {
				t.Fatal("retired an invalid application completion record")
			}
			if remaining, err := os.ReadFile(filename); err != nil || string(remaining) != string(data) {
				t.Fatal("rejected retirement changed the original record")
			}
		})
	}
}

func TestApplicationToolAdmissionRetirementPreservesBusyRecord(t *testing.T) {
	policy, manifest, root, filename := applicationInstalledFixture(t)
	if err := policy.admitApplicationTools(root, manifest, policy.PackVersion); err != nil {
		t.Fatal(err)
	}
	busy, err := pinFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	if err := RetireApplicationTools(root); err == nil {
		t.Fatal("retired a record with a conflicting pinned reader")
	}
	if _, err := os.Stat(filename); err != nil {
		t.Fatal("busy record was removed")
	}
	if err := busy.Close(); err != nil {
		t.Fatal(err)
	}
	if err := RetireApplicationTools(root); err != nil {
		t.Fatal(err)
	}
}

func TestApplicationToolAdmissionRetirementRequiresInstalledIdentity(t *testing.T) {
	if err := RetireApplicationTools(t.TempDir()); err == nil {
		t.Fatal("retirement accepted a root without installed application identity")
	}
}
