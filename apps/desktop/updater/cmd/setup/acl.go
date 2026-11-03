package main

import (
	"cmp"
	"slices"

	"scholarseed.local/desktop/updater/internal/security"
)

type permissionRole uint8

const (
	permissionContent permissionRole = iota
	permissionAncestor
	permissionVolume
	permissionRuntime
	permissionReadExecute      uint32 = 0x001200a9
	permissionAddChildren      uint32 = 0x00000006
	permissionDelete           uint32 = 0x00010000
	permissionMetadata         uint32 = 0x00000110
	permissionAll              uint32 = 0x001f01ff
	permissionGenericRead      uint32 = 0x80000000
	permissionGenericWrite     uint32 = 0x40000000
	permissionGenericExecute   uint32 = 0x20000000
	permissionGenericAll       uint32 = 0x10000000
	permissionFileWrite        uint32 = 0x00120116
	permissionFileExecute      uint32 = 0x001200a0
	permissionFileRead         uint32 = 0x00120089
	permissionInheritOnly      byte   = 0x08
	permissionContainerInherit byte   = 0x02
	permissionObjectInherit    byte   = 0x01
	permissionEveryone                = security.SidEveryone
)

type permissionEntry struct {
	SID   string
	Mask  uint32
	Flags byte
	Deny  bool
}

const permissionNoPropagate byte = 0x04
const permissionScopeCount = 5

type permissionSubject struct{ Allow, Deny bool }

func permissionMask(mask uint32) uint32            { return security.Mask(mask) }
func permissionAllowed(role permissionRole) uint32 { return security.Allowed(int(role)) }
func permissionScopes(entry permissionEntry, role permissionRole) []int {
	var scopes []int
	for scope := 0; scope < permissionScopeCount; scope++ {
		if security.Applies(uint32(entry.Flags), int(role), scope) {
			scopes = append(scopes, scope)
		}
	}
	return scopes
}

func permissionEntries(entries []permissionEntry, trusted func(string) bool, subjects map[string]permissionSubject) []security.Entry {
	ids := map[string]uint32{}
	result := make([]security.Entry, len(entries))
	for i, entry := range entries {
		id, exists := ids[entry.SID]
		if !exists {
			id = uint32(len(ids))
			ids[entry.SID] = id
		}
		subject := subjects[entry.SID]
		result[i] = security.Entry{Principal: id, Mask: entry.Mask, Flags: uint32(entry.Flags), Deny: entry.Deny,
			Trusted: trusted(entry.SID), Universal: entry.SID == permissionEveryone, AllowSubject: subject.Allow, DenySubject: subject.Deny}
	}
	return result
}
func permissionWriters(entries []permissionEntry, role permissionRole, trusted func(string) bool) map[string]uint32 {
	snapshot := permissionEntries(entries, trusted, nil)
	writers := map[string]uint32{}
	for i, entry := range entries {
		for scope := 0; scope < permissionScopeCount; scope++ {
			if mask := security.Danger(snapshot, int(role), i, scope); mask != 0 {
				writers[entry.SID] |= mask
			}
		}
	}
	return writers
}
func permissionDeniesExecution(entries []permissionEntry, subjects map[string]permissionSubject) bool {
	snapshot := permissionEntries(entries, func(string) bool { return true }, subjects)
	return security.Evaluate(snapshot, int(permissionRuntime), true).Reason != 0
}

func normalizeDirectoryRisks(risks []directoryRisk) []directoryRisk {
	result := slices.Clone(risks)
	slices.SortFunc(result, func(a, b directoryRisk) int {
		if n := cmp.Compare(a.Path, b.Path); n != 0 {
			return n
		}
		if n := cmp.Compare(a.Reason, b.Reason); n != 0 {
			return n
		}
		return cmp.Compare(a.Principal, b.Principal)
	})
	merged := result[:0]
	for _, risk := range result {
		if len(merged) > 0 {
			last := &merged[len(merged)-1]
			if last.Path == risk.Path && last.Reason == risk.Reason && last.Principal == risk.Principal {
				last.Mask |= risk.Mask
				continue
			}
		}
		merged = append(merged, risk)
	}
	return merged
}

func sameDirectoryRisks(a, b []directoryRisk) bool {
	return slices.Equal(normalizeDirectoryRisks(a), normalizeDirectoryRisks(b))
}
