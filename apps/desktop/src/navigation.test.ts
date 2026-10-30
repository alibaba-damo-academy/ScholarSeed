import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeNavigationDocument, sanitizeNavigationLocation } from './navigation.ts'

test('retired MCP settings navigation is discarded without losing the current view', () => {
  const restored = sanitizeNavigationLocation({ view: 'skills', settingsPage: 'mcp' })
  assert.equal(restored?.view, 'skills')
  assert.equal(restored?.settingsPage, null)
})

test('Markdown text mode survives navigation restoration', () => {
  const target = {
    kind: 'document',
    source: { kind: 'project', path: 'resources/note.md', project: null },
    viewKind: 'source',
    title: 'note.md',
  }
  assert.deepEqual(sanitizeNavigationLocation({ view: 'resource', target })?.target, target)
})

test('navigation document pointers keep identity and discard content and transient state', () => {
  assert.deepEqual(
    sanitizeNavigationDocument({
      kind: 'project',
      project: 'project-a',
      path: 'resources/note.md',
      assetId: 'asset-a',
      bytes: [1, 2],
      text: 'unsaved text',
      dirty: true,
      pendingClose: true,
    }),
    { kind: 'project', path: 'resources/note.md', assetId: 'asset-a', project: 'project-a' }
  )
})

test('registered document identities survive serialization without importing renderer implementation', () => {
  const sources = [
    { kind: 'project', project: 'project-a', path: 'a.md' },
    { kind: 'session-file', sessionId: 'session-a', path: 'a.md' },
    { kind: 'session-artifact', sessionId: 'session-a', artifactId: 'artifact-a', path: 'a.md' },
    { kind: 'runtime-file', path: 'C:\\research\\note.md' },
    { kind: 'builtin', id: 'guide', path: 'guide.md' },
    {
      kind: 'version',
      project: 'project-a',
      versionId: 'version-a',
      revision: 'sha-a',
      path: 'a.md',
    },
    {
      kind: 'review-base',
      project: 'project-a',
      fileId: 'file-a',
      reviewId: 'review-a',
      revision: 'sha-a',
      path: 'a.md',
    },
    {
      kind: 'literature',
      literatureId: 'paper-a',
      attachmentId: 'pdf-a',
      path: 'paper.pdf',
      recordTarget: { owner: 'literature_attachment', scope_id: 'paper-a', subject_id: 'pdf-a' },
    },
  ]
  for (const source of sources) {
    assert.deepEqual(sanitizeNavigationDocument(JSON.parse(JSON.stringify(source))), source)
  }
})

test('malformed document pointers fall back without losing the valid page', () => {
  for (const source of [
    { kind: 'session-file', path: 'a.md' },
    { kind: 'literature', path: 'paper.pdf', literatureId: 'paper-a', attachmentId: 'pdf-a' },
    { kind: 'removed', path: 'a.md' },
    { kind: 'project', path: '' },
  ]) {
    const restored = sanitizeNavigationLocation({
      view: 'literature',
      target: { kind: 'document', source, viewKind: 'preview' },
    })!
    assert.equal(restored.view, 'literature')
    assert.equal(restored.target, null)
  }
})

test('navigation sanitization does not normalize macOS or Windows document paths into another identity', () => {
  for (const path of ['/Users/test/paper.md', 'C:\\Users\\test\\paper.md', 'resources/论文.md']) {
    assert.equal(sanitizeNavigationDocument({ kind: 'runtime-file', path })?.path, path)
  }
})

test('browser view and settings page survive navigation restoration', () => {
  const restored = sanitizeNavigationLocation({ view: 'browser', settingsPage: 'browser' })
  assert.equal(restored?.view, 'browser')
  assert.equal(restored?.settingsPage, 'browser')
})

test('only overview and history sections survive browser settings restoration', () => {
  for (const browserSettingsSection of ['overview', 'history']) {
    assert.equal(
      sanitizeNavigationLocation({
        view: 'browser',
        settingsPage: 'browser',
        browserSettingsSection,
      })?.browserSettingsSection,
      browserSettingsSection
    )
  }
  for (const browserSettingsSection of [undefined, 'data', 'downloads', 'unknown']) {
    assert.equal(
      sanitizeNavigationLocation({ view: 'home', settingsPage: 'browser', browserSettingsSection })
        ?.browserSettingsSection,
      'overview'
    )
  }
  for (const settingsPage of [null, 'models']) {
    assert.equal(
      sanitizeNavigationLocation({ view: 'home', settingsPage, browserSettingsSection: 'history' })
        ?.browserSettingsSection,
      null
    )
  }
})
