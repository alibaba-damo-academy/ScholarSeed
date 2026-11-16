import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDocumentReference } from './api.ts'
import { relativeReferenceLink } from './links.ts'

test('relative references reject external, traversal and platform escape forms', () => {
  for (const value of [
    'references.md#ref-key',
    '文献%20列表.md#ref-Author:2025',
    'part/references.markdown#ref-a',
  ])
    assert.equal(relativeReferenceLink(value), true, value)
  for (const value of [
    'https://site/references.md#ref-a',
    '//host/a.md#ref-a',
    '../a.md#ref-a',
    '/a.md#ref-a',
    'C:/a.md#ref-a',
    'C:\\a.md#ref-a',
    '%2e%2e/a.md#ref-a',
    '%252e%252e/a.md#ref-a',
    'a%2fb.md#ref-a',
    'a.md?project=other#ref-a',
    'a.md#ref-%00',
    'a.md#ref-%invalid',
  ])
    assert.equal(relativeReferenceLink(value), false, value)
})

test('reference read binds scope and revision without opening or modifying a document', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const requested: string[] = []
  let responseRevision = 'source'
  globalThis.fetch = async (input, options) => {
    requested.push(String(input))
    assert.equal(options?.method, undefined)
    return Response.json({
      text: '<a id="ref-key"></a>\nReference',
      fragment: '#ref-key',
      revision: 'target',
      source_revision: responseRevision,
    })
  }
  try {
    await resolveDocumentReference(
      { kind: 'project', project: 'scope', path: 'resources/report.md' },
      'source',
      'references.md#ref-key'
    )
    const request = new URL(requested[0])
    assert.equal(request.pathname, '/api/workbench/reference')
    assert.equal(request.searchParams.get('project'), 'scope')
    assert.equal(request.searchParams.get('path'), 'resources/report.md')
    assert.equal(request.searchParams.get('revision'), 'source')
    await resolveDocumentReference(
      { kind: 'session-artifact', sessionId: 'session', artifactId: 'artifact', path: 'ignored' },
      'source',
      'references.md#ref-key'
    )
    assert.equal(
      new URL(requested[1]).pathname,
      '/api/assistant/sessions/session/artifacts/artifact/reference'
    )
    await assert.rejects(
      resolveDocumentReference(
        { kind: 'project', project: 'scope', path: 'a.md' },
        'source',
        'https://site/a.md#ref-a'
      )
    )
    assert.equal(requested.length, 2)
    responseRevision = 'stale'
    await assert.rejects(
      resolveDocumentReference(
        { kind: 'project', project: 'scope', path: 'a.md' },
        'source',
        'references.md#ref-key'
      )
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
