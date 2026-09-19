import assert from 'node:assert/strict'
import test from 'node:test'

import { assistantSourceAvailable, filterAssistantContextCandidates, isSessionContextCandidate, resolveAssistantProject } from './candidates.ts'

test('project-only assistant sources are unavailable in global conversations', () => {
  assert.equal(assistantSourceAvailable({ requiresProject: true }, null), false)
  assert.equal(assistantSourceAvailable({ requiresProject: true }, 'project-1'), true)
  assert.equal(assistantSourceAvailable({}, null), true)
})

test('assistant project follows the conversation, preserves unresolved identity and separates drafts', () => {
  const projects = [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }]
  assert.deepEqual(resolveAssistantProject('session', '/a', 'b', projects), { projectId: 'a', projectPath: '/a' })
  assert.deepEqual(resolveAssistantProject('session', '/a', null, projects), { projectId: 'a', projectPath: '/a' })
  assert.deepEqual(resolveAssistantProject('session', null, 'b', projects), { projectId: null, projectPath: null })
  assert.deepEqual(resolveAssistantProject(null, null, 'b', projects), { projectId: 'b', projectPath: '/b' })
  assert.deepEqual(resolveAssistantProject('session', '/a', null, []), { projectId: null, projectPath: '/a' })
})

test('session context candidates exclude empty and active conversations', () => {
  assert.equal(
    isSessionContextCandidate({ session_id: 'empty-session', turns: 0 }, 'active-session'),
    false
  )
  assert.equal(
    isSessionContextCandidate({ session_id: 'active-session', turns: 1 }, 'active-session'),
    false
  )
  assert.equal(
    isSessionContextCandidate({ session_id: 'completed-session', turns: 1 }, 'active-session'),
    true
  )
})

test('assistant context quick filters retain all items or sort complete candidate metadata', () => {
  const candidates = [
    { kind: 'file' as const, source_id: 'older', label: 'Older', origin: 'explicit' as const, created_at: 1, opened_at: 30 },
    { kind: 'file' as const, source_id: 'newer', label: 'Newer', origin: 'explicit' as const, created_at: 2 },
    { kind: 'file' as const, source_id: 'recent', label: 'Recent', origin: 'explicit' as const, created_at: 0, opened_at: 40 }
  ]
  assert.deepEqual(filterAssistantContextCandidates(candidates, 'all').map((item) => item.source_id), ['older', 'newer', 'recent'])
  assert.deepEqual(filterAssistantContextCandidates(candidates, 'recent').map((item) => item.source_id), ['recent', 'older'])
  assert.deepEqual(filterAssistantContextCandidates(candidates, 'newest').map((item) => item.source_id), ['newer', 'older', 'recent'])
})
