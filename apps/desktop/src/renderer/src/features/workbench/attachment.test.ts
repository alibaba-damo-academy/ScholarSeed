import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'

import {
  commitDocument,
  isDocumentLoadFailure,
  isLocatedDocumentSource,
  loadDocument,
  loadPdfRecords,
  commitPdfRecords,
  subscribePdfRecords,
  resolveDocumentLocation,
  resolveDocumentRevealPath,
  resolveArtifactCitation,
  documentIdFor,
  type PdfRecordSnapshot,
  type SessionArtifactSource,
} from './api.ts'
import type {
  LiteratureDocumentSource,
  SessionFileSource,
  ViewerKind,
} from '../../contracts/workbench.ts'
import { sanitizeNavigationDocument } from '../../../../navigation.ts'
import type { NotificationFrame } from '../../../../notifications.ts'

test('system reveal resolves the source of the selected document without opening the snapshot cache', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const roots: string[] = []
  let root = '/work/session'
  let directory: string | undefined
  globalThis.window = {
    scholarseed: {
      getApiBase: () => 'http://test',
      addAuthorizedRoot: async (scope: string, path: string) => {
        assert.equal(scope, 'session')
        roots.push(path)
        return true
      },
    },
  } as unknown as Window & typeof globalThis
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'http://test/api/serve/sessions/session/files')
    return Response.json({
      root,
      artifacts: directory
        ? [{ artifact_id: 'artifact', kind: 'directory', absolute_path: directory }]
        : [],
    })
  }
  const artifact: SessionArtifactSource = {
    kind: 'session-artifact',
    sessionId: 'session',
    artifactId: 'artifact',
    path: 'output/report.md',
  }
  try {
    assert.equal(await resolveDocumentRevealPath(artifact), '/work/session/output/report.md')
    assert.deepEqual(roots, ['/work/session'])
    assert.equal(await resolveDocumentRevealPath({ ...artifact, path: '../private.md' }), undefined)
    assert.equal(
      await resolveDocumentRevealPath({ ...artifact, memberPath: 'report.md' }),
      undefined
    )
    root = 'C:\\workspace\\session'
    assert.equal(
      await resolveDocumentRevealPath(artifact),
      'C:\\workspace\\session\\output\\report.md'
    )
    directory = 'C:\\workspace\\session\\nested'
    assert.equal(
      await resolveDocumentRevealPath({ ...artifact, memberPath: 'report.md' }),
      'C:\\workspace\\session\\nested\\report.md'
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

function recordWindow() {
  const events = new EventTarget()
  const listeners = new Set<(frame: NotificationFrame) => void>()
  let syncs = 0
  return {
    window: {
      scholarseed: {
        getApiBase: () => 'http://test',
        notifications: {
          onChange(listener: (frame: NotificationFrame) => void) {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
          async sync() {
            syncs++
          },
        },
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    } as unknown as Window & typeof globalThis,
    assertReleased() {
      assert.equal(syncs, 1)
      assert.equal(listeners.size, 0, 'notification bridge subscription must be released')
      for (const event of ['focus', 'scholarseed:auth-restored', 'scholarseed:auth-required']) {
        assert.equal(
          getEventListeners(events, event).length,
          0,
          `${event} listener must be released`
        )
      }
    },
  }
}

const SOURCE: LiteratureDocumentSource = {
  kind: 'literature',
  literatureId: 'paper',
  attachmentId: 'figure',
  recordTarget: {
    owner: 'literature_attachment',
    scope_id: 'paper',
    subject_id: 'figure',
  },
  path: 'figure.png',
  mediaType: 'application/pdf',
}

function artifactProjection(viewer: ViewerKind, editable = false, revision = 'sha256:current') {
  return Response.json({
    viewer,
    processor: null,
    content_kind: viewer === 'code' || viewer === 'markdown' ? 'text' : 'binary',
    capabilities: {
      can_preview: viewer !== 'unsupported',
      can_edit: editable,
      can_select: false,
      can_annotate: false,
      can_save: editable,
      can_version: false,
      can_diff: false,
      pending: [],
    },
    revision,
    media_type: 'application/octet-stream',
  })
}

test('artifact open consumes registry projection even when MIME and render hints disagree', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const requests: string[] = []
  const capabilities = {
    can_preview: true,
    can_edit: true,
    can_select: false,
    can_annotate: false,
    can_save: true,
    can_version: false,
    can_diff: false,
    pending: [],
  }
  try {
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return String(input).endsWith('/open')
        ? Response.json({
            viewer: 'code',
            processor: null,
            content_kind: 'text',
            capabilities,
            revision: 'sha256:current',
            media_type: 'application/octet-stream',
          })
        : new Response('theorem sample : True := by trivial', {
            headers: { 'Content-Type': 'image/png' },
          })
    }
    const loaded = await loadDocument({
      kind: 'session-artifact',
      sessionId: 'session',
      artifactId: 'proof',
      path: 'proof.lean',
      renderKind: 'image',
      revision: 'sha256:old',
    })
    assert.ok(!isDocumentLoadFailure(loaded))
    assert.equal(loaded.viewer, 'code')
    assert.equal(loaded.contentKind, 'text')
    assert.equal(loaded.revision, 'sha256:current')
    assert.deepEqual(loaded.capabilities, capabilities)
    assert.deepEqual(requests, [
      'http://test/api/serve/sessions/session/artifacts/proof/open',
      'http://test/api/serve/sessions/session/artifacts/proof/raw',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('artifact members retain processor metadata and append compatibility preview to their member query', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const requests: string[] = []
  try {
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      if (String(input).includes('/open?')) {
        const projection = await artifactProjection('spreadsheet').json()
        return Response.json({ ...projection, processor: 'ods', content_kind: 'binary' })
      }
      return new Response('converted workbook')
    }
    const loaded = await loadDocument({
      kind: 'session-artifact',
      sessionId: 'session',
      artifactId: 'folder',
      path: 'table.ods',
      memberPath: 'tables/table.ods',
    })
    assert.ok(!isDocumentLoadFailure(loaded))
    assert.equal(loaded.viewer, 'spreadsheet')
    assert.equal(loaded.processor, 'ods')
    assert.equal(loaded.capabilities.can_edit, false)
    assert.deepEqual(requests, [
      'http://test/api/serve/sessions/session/artifacts/folder/open?member=tables%2Ftable.ods',
      'http://test/api/serve/sessions/session/artifacts/folder/raw?member=tables%2Ftable.ods&preview=true',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('fallback document opens classify bytes instead of calling unknown MIME types binary', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const text = '\\documentclass{article}\n中文公式 $E=mc^2$\n'
  const cases = [
    ['公式.tex', 'application/x-tex', text, 'code', 'text'],
    ['文献.bib', 'application/x-bibtex', '@article{sample, title={中文文献}}', 'code', 'text'],
    ['source.TEX', 'application/octet-stream', text, 'code', 'text'],
    ['notes.custom', 'application/x-custom-document', '未知文档\r\n内容', 'code', 'text'],
    ['README', 'application/octet-stream', 'plain text', 'code', 'text'],
    ['empty.custom', 'application/octet-stream', '', 'code', 'text'],
    ['notes.md', 'text/markdown', '# Markdown', 'markdown', 'text'],
    ['opaque.bin', 'application/octet-stream', new Uint8Array([0, 65]), 'unsupported', 'binary'],
    ['invalid.tex', 'application/x-tex', new Uint8Array([255, 254, 128]), 'unsupported', 'binary'],
    ['fake.txt', 'text/plain', new Uint8Array([65, 0, 66]), 'unsupported', 'binary'],
    ['invalid.txt', 'text/plain', new Uint8Array([255]), 'unsupported', 'binary'],
    ['paper.pdf', 'application/pdf', '%PDF-1.7', 'pdf', 'binary'],
  ] as const
  try {
    for (const [path, mediaType, payload, viewer, contentKind] of cases) {
      const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
      globalThis.fetch = async () =>
        new Response(bytes, {
          headers: { 'Content-Type': mediaType },
        })
      for (const kind of ['session-file', 'runtime-file'] as const) {
        const source =
          kind === 'session-file' ? { kind, sessionId: 'session', path } : { kind, path }
        const loaded = await loadDocument(source)
        assert.ok(!isDocumentLoadFailure(loaded), `${kind}: ${path}`)
        assert.equal(loaded.viewer, viewer, `${kind}: ${path}`)
        assert.equal(loaded.contentKind, contentKind, `${kind}: ${path}`)
        assert.equal(loaded.capabilities.can_preview, viewer !== 'unsupported')
        assert.equal(loaded.capabilities.can_edit, false)
        assert.equal(loaded.capabilities.can_save, false)
        assert.deepEqual(loaded.bytes, bytes)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('artifact projection preserves server save authority and does not download unsupported bytes', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const source: SessionArtifactSource = {
    kind: 'session-artifact',
    sessionId: 'session',
    artifactId: 'bib',
    path: '文献.bib',
  }
  try {
    for (const binary of [false, true]) {
      const requests: string[] = []
      globalThis.fetch = async (input) => {
        requests.push(String(input))
        if (String(input).endsWith('/open'))
          return artifactProjection(binary ? 'unsupported' : 'code', !binary)
        return new Response(
          binary
            ? new Uint8Array([0, 255])
            : new TextEncoder().encode('@article{sample, title={中文文献}}'),
          {
            headers: {
              'Content-Type': 'application/x-bibtex',
              'X-ScholarSeed-Artifact-Editable': 'true',
            },
          }
        )
      }
      const loaded = await loadDocument(source)
      assert.ok(!isDocumentLoadFailure(loaded))
      assert.equal(loaded.viewer, binary ? 'unsupported' : 'code')
      assert.equal(loaded.capabilities.can_preview, !binary)
      assert.equal(loaded.capabilities.can_edit, !binary)
      assert.equal(loaded.capabilities.can_save, !binary)
      assert.equal(loaded.capabilities.can_version, false)
      assert.equal(loaded.capabilities.can_diff, false)
      assert.equal(requests.length, binary ? 1 : 2)
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('directory members use distinct immutable identities, exact raw paths and read-only capabilities', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const source: SessionArtifactSource = {
    kind: 'session-artifact',
    sessionId: 'session',
    artifactId: 'directory',
    path: 'sub/中文 #1.pdf',
    memberPath: 'sub/中文 #1.pdf',
    revision: 'member-hash',
  }
  const requests: string[] = []
  try {
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      if (String(input).includes('/open?')) return artifactProjection('pdf', false, 'member-hash')
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'application/pdf', 'X-ScholarSeed-Artifact-Editable': 'true' },
      })
    }
    assert.notEqual(documentIdFor(source), documentIdFor({ ...source, memberPath: 'other.pdf' }))
    assert.notEqual(documentIdFor(source), documentIdFor({ ...source, memberPath: undefined }))
    const restored = sanitizeNavigationDocument(JSON.parse(JSON.stringify(source)))
    assert.ok(restored?.kind === 'session-artifact')
    assert.deepEqual(restored, source)
    assert.equal(documentIdFor(restored), documentIdFor(source))
    const loaded = await loadDocument(restored)
    assert.ok(!isDocumentLoadFailure(loaded))
    assert.equal(loaded.viewer, 'pdf')
    assert.equal(loaded.revision, 'member-hash')
    assert.equal(loaded.capabilities.can_edit, false)
    assert.equal(loaded.capabilities.can_save, false)
    assert.equal(loaded.capabilities.can_annotate, false)
    assert.deepEqual(await commitDocument(source, new Uint8Array([4]), 'member-hash'), {
      ok: false,
      error: 'unavailable',
    })
    await assert.rejects(
      resolveArtifactCitation(source, 'member-hash', 'citation'),
      /document_reference_unavailable/
    )
    assert.deepEqual(requests, [
      'http://test/api/serve/sessions/session/artifacts/directory/open?member=sub%2F%E4%B8%AD%E6%96%87+%231.pdf',
      'http://test/api/serve/sessions/session/artifacts/directory/raw?member=sub%2F%E4%B8%AD%E6%96%87+%231.pdf',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('PDF subscription loads without SSE ready and recovers after 503 without another event', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const fixture = recordWindow()
  globalThis.window = fixture.window
  let requests = 0
  let failures = 0
  const received: string[] = []
  const flush = async (): Promise<void> => {
    context.mock.timers.tick(0)
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
  globalThis.fetch = async () => {
    requests++
    return requests === 1
      ? new Response(null, { status: 503 })
      : Response.json({
          record_target: SOURCE.recordTarget,
          source_revision: 'source',
          record_revision: 'recovered',
          source_state: 'available',
          records: { schema_version: 1, marks: [], comments: [], notes: [] },
        })
  }
  const unsubscribe = subscribePdfRecords(
    SOURCE,
    (snapshot) => received.push(snapshot.record_revision),
    () => {
      failures++
    }
  )
  try {
    await flush()
    assert.equal(requests, 1, 'initial load must not depend on SSE ready or focus')
    assert.equal(failures, 1, 'unavailability must remain observable')
    assert.deepEqual(received, [])
    context.mock.timers.tick(500)
    await flush()
    assert.deepEqual(received, ['recovered'])
    context.mock.timers.tick(60_000)
    await flush()
    assert.equal(requests, 2, 'successful recovery must return to event-driven idle')
  } finally {
    unsubscribe()
    fixture.assertReleased()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('PDF subscription cancellation excludes late reads from a reopened document', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const fixture = recordWindow()
  globalThis.window = fixture.window
  const pending: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
  const received: string[] = []
  const flush = async (): Promise<void> => {
    context.mock.timers.tick(0)
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
  const snapshot = (revision: string): PdfRecordSnapshot => ({
    record_target: SOURCE.recordTarget,
    source_path: SOURCE.path,
    source_revision: 'source',
    record_revision: revision,
    source_state: 'available',
    records: { schema_version: 1, marks: [], comments: [], notes: [] },
  })
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((resolve) => {
      pending.push({ signal: init?.signal as AbortSignal, resolve })
    })
  let unsubscribe = subscribePdfRecords(SOURCE, (value) => received.push(value.record_revision))
  try {
    await flush()
    assert.equal(pending.length, 1)
    unsubscribe()
    assert.equal(pending[0].signal.aborted, true)
    unsubscribe = subscribePdfRecords(SOURCE, (value) => received.push(value.record_revision))
    await flush()
    pending[1].resolve(Response.json(snapshot('current')))
    await flush()
    pending[0].resolve(Response.json(snapshot('stale')))
    await flush()
    assert.deepEqual(received, ['current'])
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('PDF permanent read failures remain visible and do not retry until focus', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const fixture = recordWindow()
  globalThis.window = fixture.window
  let requests = 0
  let failures = 0
  const flush = async (): Promise<void> => {
    context.mock.timers.tick(0)
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
  globalThis.fetch = async () => {
    requests++
    return new Response(null, { status: 403 })
  }
  const unsubscribe = subscribePdfRecords(
    SOURCE,
    () => assert.fail('403 is not empty records'),
    () => {
      failures++
    }
  )
  try {
    await flush()
    assert.equal(failures, 1)
    context.mock.timers.tick(60_000)
    await flush()
    assert.equal(requests, 1)
    fixture.window.dispatchEvent(new Event('focus'))
    await flush()
    assert.equal(requests, 2)
    assert.equal(failures, 2)
  } finally {
    unsubscribe()
    fixture.assertReleased()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('PDF refresh cannot replace a committed snapshot with its earlier read', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const fixture = recordWindow()
  globalThis.window = fixture.window
  const snapshot: PdfRecordSnapshot = {
    record_target: SOURCE.recordTarget,
    source_path: SOURCE.path,
    source_revision: 'source',
    record_revision: 'saved',
    source_state: 'available',
    records: { schema_version: 1, marks: [], comments: [], notes: [] },
  }
  let resolveRead: ((response: Response) => void) | undefined
  let requests = 0
  const received: string[] = []
  const flush = async (): Promise<void> => {
    context.mock.timers.tick(0)
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') return Response.json(snapshot)
    requests++
    if (requests === 1)
      return new Promise<Response>((resolve) => {
        resolveRead = resolve
      })
    return Response.json(snapshot)
  }
  const unsubscribe = subscribePdfRecords(SOURCE, (value) => received.push(value.record_revision))
  try {
    await flush()
    assert.ok(resolveRead)
    await commitPdfRecords(SOURCE, snapshot.records, 'previous', 'source')
    resolveRead(Response.json({ ...snapshot, record_revision: 'stale' }))
    await flush()
    await flush()
    assert.deepEqual(received, ['saved', 'saved'])
    assert.equal(requests, 2)
  } finally {
    unsubscribe()
    fixture.assertReleased()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('PDF notifications share one refresher, coalesce changes and perform no idle polling', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let frame: ((value: NotificationFrame) => void) | undefined
  let detached = 0
  let requests = 0
  let revision = 'first'
  const received: string[][] = [[], []]
  const disposers: Array<() => void> = []
  const flush = async (): Promise<void> => {
    context.mock.timers.tick(0)
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
  globalThis.window = {
    scholarseed: {
      getApiBase: () => 'http://test',
      notifications: {
        onChange: (callback: (value: NotificationFrame) => void) => {
          frame = callback
          return () => {
            detached++
          }
        },
        sync: async () => {},
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis
  globalThis.fetch = async () => {
    requests++
    return Response.json({
      record_target: SOURCE.recordTarget,
      source_revision: 'source',
      record_revision: revision,
      source_state: 'available',
      records: { schema_version: 1, marks: [], comments: [], notes: [] },
    })
  }
  const changed = (): void =>
    frame?.({
      instanceId: 'serve',
      reset: false,
      changes: [{ topic: 'records', subject: 'figure' }],
    })
  try {
    await loadPdfRecords(SOURCE)
    requests = 0
    for (const results of received)
      disposers.push(
        subscribePdfRecords(SOURCE, (snapshot) => results.push(snapshot.record_revision))
      )
    revision = 'second'
    changed()
    changed()
    await flush()
    assert.equal(requests, 1)
    assert.deepEqual(received, [['second'], ['second']])
    context.mock.timers.tick(60_000)
    await flush()
    assert.equal(requests, 1)
    disposers.shift()?.()
    revision = 'third'
    changed()
    await flush()
    assert.equal(requests, 2)
    assert.deepEqual(received, [['second'], ['second', 'third']])
    disposers.shift()?.()
    changed()
    await flush()
    assert.equal(requests, 2)
    assert.equal(detached, 1)
  } finally {
    disposers.forEach((dispose) => dispose())
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('only located project and literature sources support location-bound PDF regions', () => {
  assert.equal(isLocatedDocumentSource(SOURCE), true)
  assert.equal(
    isLocatedDocumentSource({ kind: 'project', project: 'project', path: 'paper.pdf' }),
    true
  )
  for (const source of [
    { kind: 'session-artifact', sessionId: 'session', artifactId: 'paper', path: 'paper.pdf' },
    { kind: 'session-file', sessionId: 'session', path: 'paper.pdf' },
    { kind: 'runtime-file', path: 'paper.pdf' },
    {
      kind: 'version',
      project: 'project',
      versionId: 'version',
      path: 'paper.pdf',
      revision: 'sha256:paper',
    },
  ] as const) {
    assert.equal(isLocatedDocumentSource(source), false)
  }
})

test('artifact citations resolve and load PDF bytes without an answer or import receipt', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const reference = {
    session_id: 'session',
    artifact_id: 'report',
    revision: 'sha256:report',
    handle: 'source',
  }
  const requests: string[] = []
  try {
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      return String(input).includes('/raw?')
        ? new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'Content-Type': 'application/pdf' },
          })
        : Response.json({ artifact_citation: reference })
    }
    const resolved = await resolveArtifactCitation(
      { kind: 'session-artifact', sessionId: 'session', artifactId: 'report', path: 'report.md' },
      reference.revision,
      reference.handle
    )
    assert.deepEqual(resolved.artifact_citation, reference)
    const loaded = await loadDocument({
      kind: 'session-file',
      sessionId: 'session',
      path: 'paper.pdf',
      mediaType: 'application/pdf',
      artifactCitation: reference,
    })
    assert.ok(!isDocumentLoadFailure(loaded))
    assert.equal(loaded.viewer, 'pdf')
    assert.deepEqual(loaded.bytes, new Uint8Array([1, 2, 3]))
    assert.deepEqual(requests, [
      'http://test/api/assistant/sessions/session/artifacts/report/citations/source?revision=sha256%3Areport',
      'http://test/api/assistant/sessions/session/artifacts/report/citations/source/raw?revision=sha256%3Areport',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('saved PDF citations load bytes through the resource receipt without an original answer', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  let requested = ''
  try {
    globalThis.fetch = async (input) => {
      requested = String(input)
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'application/pdf', ETag: '"sha256:receipt"' },
      })
    }
    const loaded = await loadDocument({
      kind: 'session-file',
      sessionId: 'original-session',
      path: 'paper.pdf',
      mediaType: 'application/pdf',
      projectScope: 'project',
      savedCitation: { project_id: 'project', path: 'resources/report.md', handle: 'retained' },
    })
    assert.ok(!isDocumentLoadFailure(loaded))
    assert.equal(loaded.viewer, 'pdf')
    assert.deepEqual(loaded.bytes, new Uint8Array([1, 2, 3]))
    assert.equal(
      requested,
      'http://test/api/assistant/resources/citation/raw?project=project&path=resources%2Freport.md&handle=retained'
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('session artifact size failures retain the server error code', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
  } as Window & typeof globalThis
  try {
    globalThis.fetch = async () =>
      Response.json({ ok: false, error: 'session_artifact_too_large' }, { status: 413 })
    const loaded = await loadDocument({
      kind: 'session-artifact',
      sessionId: 'session',
      artifactId: 'large-pdf',
      path: 'large.pdf',
      mediaType: 'application/pdf',
    })
    assert.ok(isDocumentLoadFailure(loaded))
    assert.equal(loaded.code, 'session_artifact_too_large')
    assert.equal(loaded.status, 413)
    assert.equal(loaded.retryable, false)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachment locations resolve through their exact owner route', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const authorized: Array<{ scope: string; root: string }> = []
  globalThis.window = {
    scholarseed: {
      getApiBase: () => 'http://test',
      addAuthorizedRoot: async (scope: string, root: string) => {
        authorized.push({ scope, root })
        return true
      },
    },
  } as unknown as Window & typeof globalThis
  let requested = ''
  try {
    globalThis.fetch = async (input) => {
      requested = String(input)
      return Response.json({
        absolute: '/Users/test/.scholarseed/service/literature/files/figure.png',
      })
    }

    assert.deepEqual(await resolveDocumentLocation(SOURCE), {
      ok: true,
      absolute: '/Users/test/.scholarseed/service/literature/files/figure.png',
    })
    assert.equal(requested, 'http://test/api/v1/literatures/paper/attachments/figure/location')
    assert.deepEqual(authorized, [
      {
        scope: 'external',
        root: '/Users/test/.scholarseed/service/literature/files/figure.png',
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachment location fails when Electron rejects the exact file authorization', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: {
      getApiBase: () => 'http://test',
      addAuthorizedRoot: async () => false,
    },
  } as unknown as Window & typeof globalThis
  try {
    globalThis.fetch = async () => Response.json({ absolute: '/Users/test/paper.pdf' })

    assert.deepEqual(await resolveDocumentLocation(SOURCE), {
      ok: false,
      error: 'desktop_path_authorization_failed',
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('project linked document locations authorize only the resolved file before external opening', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const authorized: string[] = []
  globalThis.window = {
    scholarseed: {
      getApiBase: () => 'http://test',
      addAuthorizedRoot: async (scope: string, path: string) => {
        authorized.push(`${scope}:${path}`)
        return true
      },
    },
  } as unknown as Window & typeof globalThis
  try {
    globalThis.fetch = async () => Response.json({ absolute: '/external/design.html' })
    assert.deepEqual(
      await resolveDocumentLocation({
        kind: 'project',
        project: 'project',
        path: 'linked/design.html',
      }),
      { ok: true, absolute: '/external/design.html' }
    )
    assert.deepEqual(authorized, ['external:/external/design.html'])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachments use the server workbench projection before loading content', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
  } as Window & typeof globalThis
  try {
    const requests: string[] = []
    globalThis.fetch = async (request) => {
      const url = String(request)
      requests.push(url)
      if (url.endsWith('/open')) {
        return Response.json({
          viewer: 'office',
          content_kind: 'binary',
          capabilities: {
            can_preview: true,
            can_edit: true,
            can_select: true,
            can_annotate: false,
            can_save: true,
            can_version: false,
            can_diff: false,
            pending: [],
          },
          media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 4,
          revision: 'sha256:office',
        })
      }
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }
    const loaded = await loadDocument(SOURCE)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.viewer, 'office')
    assert.equal(
      loaded.mediaType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    assert.equal(loaded.revision, 'sha256:office')
    assert.equal(loaded.capabilities.can_select, true)
    assert.equal(loaded.capabilities.can_edit, true)
    assert.equal(loaded.capabilities.can_save, true)
    assert.deepEqual(requests, [
      'http://test/api/v1/literatures/paper/attachments/figure/open',
      'http://test/api/v1/literatures/paper/attachments/figure/content',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('project documents reuse versioning from the open projection', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
  } as Window & typeof globalThis
  try {
    const requests: string[] = []
    const versioning = {
      file_id: 'file-notes',
      version_id: 'version-notes',
      working_revision: 'sha256:notes',
      disk_revision: 'sha256:notes',
      manual_admitted: false,
      can_version: true,
      can_diff: true,
      can_preview_history: true,
      management_state: 'managed',
      drifted: false,
      snapshot_state: 'saved',
      pending: null,
    }
    globalThis.fetch = async (request) => {
      const url = String(request)
      requests.push(url)
      if (url.startsWith('http://test/api/workbench/open?')) {
        return Response.json({
          path: 'resources/notes.md',
          viewer: 'markdown',
          processor: null,
          content_kind: 'text',
          capabilities: {
            can_preview: true,
            can_edit: true,
            can_select: true,
            can_annotate: false,
            can_save: true,
            can_version: true,
            can_diff: true,
            pending: [],
          },
          project_id: 'project',
          media_type: 'text/markdown',
          size: 8,
          revision: 'sha256:notes',
          content_url: '/api/workbench/content',
          asset_id: null,
          source_state: null,
          versioning,
        })
      }
      if (url.startsWith('http://test/api/workbench/content?')) {
        return new Response('# notes', { headers: { 'Content-Type': 'text/markdown' } })
      }
      throw new Error(`unexpected request: ${url}`)
    }

    const loaded = await loadDocument({
      kind: 'project',
      project: 'project',
      path: 'resources/notes.md',
    })
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.deepEqual(loaded.versioning, versioning)
    assert.deepEqual(requests, [
      'http://test/api/workbench/open?path=resources%2Fnotes.md&project=project',
      'http://test/api/workbench/content?path=resources%2Fnotes.md&project=project',
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('unsupported literature attachments do not download their content', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
  } as Window & typeof globalThis
  try {
    const requests: string[] = []
    globalThis.fetch = async (request) => {
      requests.push(String(request))
      return Response.json({
        viewer: 'unsupported',
        content_kind: 'binary',
        capabilities: {
          can_preview: false,
          can_edit: false,
          can_select: false,
          can_annotate: false,
          can_save: false,
          can_version: false,
          can_diff: false,
          pending: ['binary_preview_unsupported'],
        },
        media_type: 'application/octet-stream',
        size: 4,
        revision: 'sha256:opaque',
      })
    }
    const loaded = await loadDocument(SOURCE)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.viewer, 'unsupported')
    assert.equal(loaded.bytes.byteLength, 0)
    assert.deepEqual(requests, ['http://test/api/v1/literatures/paper/attachments/figure/open'])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('readonly literature XLSX preserves original formula caches while legacy formats use compatibility bytes', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    const requests: string[] = []
    globalThis.fetch = async (request) => {
      const url = String(request)
      requests.push(url)
      if (url.endsWith('/open')) {
        return Response.json({
          viewer: 'spreadsheet',
          content_kind: 'binary',
          capabilities: {
            can_preview: true,
            can_edit: false,
            can_select: true,
            can_annotate: false,
            can_save: false,
            can_version: false,
            can_diff: false,
            pending: ['spreadsheet_complex_content'],
          },
          media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 4,
          revision: 'sha256:sheet',
        })
      }
      return new Response(new Uint8Array([80, 75, 3, 4]))
    }
    for (const extension of ['xlsx', 'xls']) {
      requests.length = 0
      const loaded = await loadDocument({ ...SOURCE, path: `figure.${extension}` })
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      assert.deepEqual(requests, [
        'http://test/api/v1/literatures/paper/attachments/figure/open',
        `http://test/api/v1/literatures/paper/attachments/figure/content${extension === 'xls' ? '?preview=true' : ''}`,
      ])
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachments commit bytes through their exact identity and revision', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
  } as Window & typeof globalThis
  try {
    let request: RequestInit | undefined
    globalThis.fetch = async (_input, init) => {
      request = init
      return new Response(null, { status: 204, headers: { ETag: '"sha256:next"' } })
    }
    const committed = await commitDocument(SOURCE, new Uint8Array([1, 2, 3]), 'sha256:before')
    assert.deepEqual(committed, { ok: true, revision: 'sha256:next' })
    assert.equal(request?.method, 'PUT')
    assert.equal(new Headers(request?.headers).get('if-match'), '"sha256:before"')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('mutable session artifacts expose the matching text and spreadsheet editors', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    const cases = [
      { path: 'notes.txt', mediaType: 'text/plain', viewer: 'code' },
      {
        path: 'script.py',
        mediaType: 'text/x-python',
        viewer: 'code',
      },
      {
        path: 'data.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        viewer: 'spreadsheet',
      },
    ] as const
    for (const entry of cases) {
      globalThis.fetch = async (input) =>
        String(input).endsWith('/open')
          ? artifactProjection(entry.viewer, true)
          : new Response('artifact', {
              headers: {
                'Content-Type': entry.mediaType,
                'X-ScholarSeed-Artifact-Editable': 'true',
              },
            })
      const source: SessionArtifactSource = {
        kind: 'session-artifact',
        sessionId: 'session',
        artifactId: 'artifact',
        path: entry.path,
        revision: 'sha256:old-publication',
      }
      const loaded = await loadDocument(source)
      if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
      assert.equal(loaded.viewer, entry.viewer)
      assert.equal(loaded.capabilities.can_edit, true)
      assert.equal(loaded.capabilities.can_save, true)
      assert.notEqual(loaded.revision, source.revision)
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('session artifact commits use the artifact identity and revision', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const source: SessionArtifactSource = {
    kind: 'session-artifact',
    sessionId: 'session',
    artifactId: 'artifact',
    path: 'report.md',
  }
  try {
    let requested = ''
    let request: RequestInit | undefined
    globalThis.fetch = async (input, init) => {
      requested = String(input)
      request = init
      return new Response(null, { status: 204, headers: { ETag: '"sha256:next"' } })
    }
    assert.deepEqual(
      await commitDocument(source, new TextEncoder().encode('# changed'), 'sha256:before'),
      { ok: true, revision: 'sha256:next' }
    )
    assert.equal(requested, 'http://test/api/serve/sessions/session/artifacts/artifact/raw')
    assert.equal(request?.method, 'PUT')
    assert.equal(new Headers(request?.headers).get('if-match'), '"sha256:before"')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachment failures retain backend code, message, status and retryability', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
  } as Window & typeof globalThis
  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          detail: {
            code: 'literature_attachment_unreadable',
            message: '附件当前无法读取',
            retryable: true,
          },
        },
        { status: 422 }
      )
    const failed = await loadDocument(SOURCE)
    assert.equal(isDocumentLoadFailure(failed), true)
    if (!isDocumentLoadFailure(failed)) assert.fail('expected typed failure')
    assert.deepEqual(failed, {
      kind: 'document-load-failure',
      code: 'literature_attachment_unreadable',
      message: '附件当前无法读取',
      retryable: true,
      status: 422,
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('citation-opened PDFs annotate through the cited literature attachment, or report no record owner', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const citation = { answerId: 'answer', answerRevision: 'answer-1', handle: 'handle' }
  const cited: SessionFileSource = {
    kind: 'session-file',
    sessionId: 'session',
    path: 'paper',
    mediaType: 'application/pdf',
    citation,
    recordTarget: SOURCE.recordTarget,
  }
  const attachment: SessionFileSource = {
    kind: 'session-file',
    sessionId: 'session',
    path: 'attachments/paper.pdf',
    mediaType: 'application/pdf',
    citation,
  }
  const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
  const snapshot: PdfRecordSnapshot = {
    record_target: SOURCE.recordTarget,
    source_revision: 'source-1',
    record_revision: 'records-1',
    source_state: 'available',
    source_path: '',
    records,
  }
  const requested: string[] = []
  try {
    globalThis.fetch = async (url) => {
      requested.push(String(url))
      return String(url).endsWith('/records')
        ? Response.json(snapshot)
        : new Response(new Uint8Array([37, 80, 68, 70]), {
            headers: { 'Content-Type': 'application/pdf' },
          })
    }
    const loaded = await loadDocument(cited)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.capabilities.can_annotate, true)
    assert.equal((await loadPdfRecords(cited))?.record_revision, 'records-1')
    assert.equal(
      requested.at(-1),
      'http://test/api/v1/literatures/paper/attachments/figure/records'
    )

    const unowned = await loadDocument(attachment)
    if (isDocumentLoadFailure(unowned)) assert.fail(unowned.code)
    assert.equal(unowned.capabilities.can_annotate, false)
    const count = requested.length
    assert.equal(await loadPdfRecords(attachment), null)
    assert.equal(requested.length, count)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('linked project and literature subscribers receive the same canonical annotation save', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const fixture = recordWindow()
  globalThis.window = fixture.window
  const project = {
    kind: 'project' as const,
    project: 'linked-project',
    path: 'resources/linked.pdf',
    assetId: 'linked-asset',
  }
  const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
  const snapshot: PdfRecordSnapshot = {
    record_target: SOURCE.recordTarget,
    source_revision: 'source-1',
    record_revision: 'records-1',
    source_state: 'available',
    source_path: '',
    records,
  }
  let updated: PdfRecordSnapshot | undefined
  let unsubscribe = (): void => {}
  try {
    globalThis.fetch = async (_url, init) =>
      Response.json(
        init?.method === 'PUT' ? { ...snapshot, record_revision: 'records-2' } : snapshot
      )
    await loadPdfRecords(project)
    await loadPdfRecords(SOURCE)
    unsubscribe = subscribePdfRecords(SOURCE, (value) => {
      updated = value
    })
    await commitPdfRecords(project, records, snapshot.record_revision, snapshot.source_revision)
    assert.equal(updated?.record_revision, 'records-2')
  } finally {
    try {
      unsubscribe()
      fixture.assertReleased()
    } finally {
      globalThis.fetch = originalFetch
      globalThis.window = originalWindow
    }
  }
})

test('focus refresh delivers annotations saved by another window', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const fixture = recordWindow()
  globalThis.window = fixture.window
  const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
  let snapshot: PdfRecordSnapshot = {
    record_target: SOURCE.recordTarget,
    source_revision: 'source-1',
    record_revision: 'external-1',
    source_state: 'available',
    source_path: '',
    records,
  }
  let unsubscribe = (): void => {}
  try {
    globalThis.fetch = async () => Response.json(snapshot)
    await loadPdfRecords(SOURCE)
    const changed = new Promise<PdfRecordSnapshot>((resolve) => {
      unsubscribe = subscribePdfRecords(SOURCE, resolve)
    })
    snapshot = { ...snapshot, record_revision: 'external-2' }
    globalThis.window.dispatchEvent(new Event('focus'))
    assert.equal((await changed).record_revision, 'external-2')
  } finally {
    try {
      unsubscribe()
      fixture.assertReleased()
    } finally {
      globalThis.fetch = originalFetch
      globalThis.window = originalWindow
    }
  }
})
