package main

import "testing"

func TestPermissionRoleMatrix(t *testing.T) {
	for _, test := range []struct {
		name   string
		role   permissionRole
		mask   uint32
		unsafe bool
	}{
		{"volume-modify", permissionVolume, 0x001301bf, false},
		{"ancestor-modify", permissionAncestor, 0x001301bf, true},
		{"ancestor-attributes", permissionAncestor, 0x100, true},
		{"ancestor-create", permissionAncestor, 6, false},
		{"content-create", permissionContent, 6, true},
		{"volume-delete-child", permissionVolume, 0x40, true},
		{"volume-change-acl", permissionVolume, 0x40000, false},
		{"volume-owner", permissionVolume, 0x80000, false},
		{"volume-generic-all", permissionVolume, permissionGenericAll, true},
		{"volume-generic-write", permissionVolume, permissionGenericWrite, false},
		{"ancestor-generic-write", permissionAncestor, permissionGenericWrite, true},
		{"read-execute", permissionContent, permissionGenericRead | permissionGenericExecute, false},
		{"unknown-right", permissionVolume, 0x00800000, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			writers := permissionWriters([]permissionEntry{{SID: "foreign", Mask: test.mask}}, test.role, func(string) bool { return false })
			if (len(writers) > 0) != test.unsafe {
				t.Fatalf("writers=%v", writers)
			}
		})
	}
}

func TestPermissionOrderedDenies(t *testing.T) {
	allow := permissionEntry{SID: "writer", Mask: permissionDelete}
	deny := permissionEntry{SID: "writer", Mask: permissionDelete, Deny: true}
	everyone := permissionEntry{SID: permissionEveryone, Mask: permissionDelete, Deny: true}
	unrelated := permissionEntry{SID: "other-user", Mask: permissionDelete, Deny: true}
	for _, test := range []struct {
		name    string
		entries []permissionEntry
		unsafe  bool
	}{
		{"same-before", []permissionEntry{deny, allow}, false},
		{"same-after", []permissionEntry{allow, deny}, true},
		{"everyone-before", []permissionEntry{everyone, allow}, false},
		{"unrelated-before", []permissionEntry{unrelated, allow}, true},
		{"partial-deny", []permissionEntry{deny, {SID: "writer", Mask: permissionDelete | 0x40000}}, true},
		{"different-scope", []permissionEntry{{SID: "writer", Mask: permissionDelete, Deny: true, Flags: permissionInheritOnly | permissionObjectInherit}, allow}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := permissionWriters(test.entries, permissionAncestor, func(string) bool { return false })
			if (len(got) > 0) != test.unsafe {
				t.Fatalf("writers=%v", got)
			}
		})
	}
}

func TestPermissionRuntimeInheritanceScopes(t *testing.T) {
	for _, flags := range []byte{0, permissionInheritOnly, permissionObjectInherit | permissionInheritOnly, permissionContainerInherit | permissionInheritOnly, permissionObjectInherit | permissionContainerInherit | permissionInheritOnly | 4} {
		entries := []permissionEntry{{SID: "writer", Mask: permissionDelete, Flags: flags}}
		got := permissionWriters(entries, permissionRuntime, func(string) bool { return false })
		want := flags != permissionInheritOnly
		if (len(got) > 0) != want {
			t.Fatalf("flags=%x writers=%v", flags, got)
		}
	}
	// A file-only inherited deny must not cancel a directory writer.
	entries := []permissionEntry{
		{SID: "writer", Mask: permissionDelete, Deny: true, Flags: permissionInheritOnly | permissionObjectInherit},
		{SID: "writer", Mask: permissionDelete, Flags: permissionInheritOnly | permissionContainerInherit},
	}
	if len(permissionWriters(entries, permissionRuntime, func(string) bool { return false })) == 0 {
		t.Fatal("cross-scope deny hid writer")
	}
}

func TestPermissionExecutionUsesTokenSubjectsAndOrder(t *testing.T) {
	subjects := map[string]permissionSubject{"user": {true, true}, "enabled-group": {true, true}, "deny-only": {false, true}}
	allow := permissionEntry{SID: "user", Mask: permissionReadExecute}
	for _, test := range []struct {
		name    string
		entries []permissionEntry
		denied  bool
	}{
		{"unrelated", []permissionEntry{{SID: "other", Mask: permissionReadExecute, Deny: true}}, false},
		{"user", []permissionEntry{{SID: "user", Mask: permissionReadExecute, Deny: true}}, true},
		{"enabled", []permissionEntry{{SID: "enabled-group", Mask: permissionReadExecute, Deny: true}}, true},
		{"disabled", []permissionEntry{{SID: "disabled", Mask: permissionReadExecute, Deny: true}}, false},
		{"deny-only", []permissionEntry{{SID: "deny-only", Mask: permissionReadExecute, Deny: true}}, true},
		{"allow-first", []permissionEntry{allow, {SID: "user", Mask: permissionReadExecute, Deny: true}}, false},
		{"inherit-file", []permissionEntry{allow, {SID: "user", Mask: permissionReadExecute, Deny: true, Flags: permissionInheritOnly | permissionObjectInherit}}, true},
		{"inert", []permissionEntry{{SID: "user", Mask: permissionReadExecute, Deny: true, Flags: permissionInheritOnly}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if permissionDeniesExecution(test.entries, subjects) != test.denied {
				t.Fatal("wrong execution result")
			}
		})
	}
}

func TestPermissionCapabilityIsNotTrustedByPrefix(t *testing.T) {
	for _, role := range []permissionRole{permissionVolume, permissionAncestor, permissionContent, permissionRuntime} {
		// Volume management is role-scoped, not a capability SID exemption.
		mask := uint32(0x40000)
		if role == permissionVolume {
			mask = 0x40
		}
		got := permissionWriters([]permissionEntry{{SID: "S-1-15-3-1234", Mask: mask}}, role, func(string) bool { return false })
		if len(got) != 1 {
			t.Fatalf("capability bypassed ACL protection for role=%v", role)
		}
	}
}

func TestDirectoryRiskComparisonUsesRelevantSemantics(t *testing.T) {
	a := []directoryRisk{{Path: "D", Principal: "writer", Reason: directoryRiskAccess, Mask: 0x40}, {Path: "D", Principal: "writer", Reason: directoryRiskAccess, Mask: 0x40000}}
	b := []directoryRisk{{Path: "D", Principal: "writer", Reason: directoryRiskAccess, Mask: 0x40040}}
	if !sameDirectoryRisks(a, b) {
		t.Fatal("equivalent risks differ")
	}
	b[0].Mask |= 0x80000
	if sameDirectoryRisks(a, b) {
		t.Fatal("new authority was silently accepted")
	}
	b[0].Mask = 0x40040
	b[0].Principal = "new-writer"
	if sameDirectoryRisks(a, b) {
		t.Fatal("new principal was silently accepted")
	}
}

func TestRuntimeNoPropagateDenyCannotHideDeeperWriter(t *testing.T) {
	for _, kind := range []byte{permissionObjectInherit, permissionContainerInherit} {
		entries := []permissionEntry{
			{SID: "writer", Mask: permissionDelete, Deny: true, Flags: permissionInheritOnly | kind | permissionNoPropagate},
			{SID: "writer", Mask: permissionDelete, Flags: permissionInheritOnly | kind},
		}
		if len(permissionWriters(entries, permissionRuntime, func(string) bool { return false })) == 0 {
			t.Fatalf("no-propagate deny hid deeper writer: flags=%x", kind)
		}
	}
	entries := []permissionEntry{
		{SID: "user", Mask: permissionReadExecute, Flags: permissionInheritOnly | permissionContainerInherit | permissionNoPropagate},
		{SID: "user", Mask: permissionReadExecute, Deny: true, Flags: permissionInheritOnly | permissionContainerInherit},
	}
	if !permissionDeniesExecution(entries, map[string]permissionSubject{"user": {true, true}}) {
		t.Fatal("shallow grant hid deeper denial")
	}
}
