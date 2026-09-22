import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commitDocument,
  isDocumentLoadFailure,
  loadDocument,
  loadPdfRecords, commitPdfRecords, subscribePdfRecords,
  resolveDocumentLocation,
  type PdfRecordSnapshot,
  type SessionArtifactSource,
  type SessionFileSource
} from './api.ts'
import type { LiteratureDocumentSource } from '../../contracts/workbench.ts'

const SOURCE: LiteratureDocumentSource = {
  kind: 'literature',
  literatureId: 'paper',
  attachmentId: 'figure',
  recordTarget: {
    owner: 'literature_attachment',
    scope_id: 'paper',
    subject_id: 'figure'
  },
  path: 'figure.png',
  mediaType: 'application/pdf'
}

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
      }
    }
  } as unknown as Window & typeof globalThis
  let requested = ''
  try {
    globalThis.fetch = async input => {
      requested = String(input)
      return Response.json({ absolute: '/Users/test/.scholarseed/service/literature/files/figure.png' })
    }

    assert.deepEqual(await resolveDocumentLocation(SOURCE), {
      ok: true,
      absolute: '/Users/test/.scholarseed/service/literature/files/figure.png'
    })
    assert.equal(requested, 'http://test/api/v1/literatures/paper/attachments/figure/location')
    assert.deepEqual(authorized, [{
      scope: 'external',
      root: '/Users/test/.scholarseed/service/literature/files/figure.png'
    }])
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
      addAuthorizedRoot: async () => false
    }
  } as unknown as Window & typeof globalThis
  try {
    globalThis.fetch = async () => Response.json({ absolute: '/Users/test/paper.pdf' })

    assert.deepEqual(await resolveDocumentLocation(SOURCE), {
      ok: false,
      error: 'desktop_path_authorization_failed'
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachments use the server workbench projection before loading content', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' }
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
            pending: []
          },
          media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 4,
          revision: 'sha256:office'
        })
      }
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: { 'Content-Type': 'application/octet-stream' }
      })
    }
    const loaded = await loadDocument(SOURCE)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.viewer, 'office')
    assert.equal(loaded.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.equal(loaded.revision, 'sha256:office')
    assert.equal(loaded.capabilities.can_select, true)
    assert.equal(loaded.capabilities.can_edit, true)
    assert.equal(loaded.capabilities.can_save, true)
    assert.deepEqual(requests, [
      'http://test/api/v1/literatures/paper/attachments/figure/open',
      'http://test/api/v1/literatures/paper/attachments/figure/content'
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
    scholarseed: { getApiBase: () => 'http://test' }
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
      pending: null
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
            pending: []
          },
          project_id: 'project',
          media_type: 'text/markdown',
          size: 8,
          revision: 'sha256:notes',
          content_url: '/api/workbench/content',
          asset_id: null,
          source_state: null,
          versioning
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
      path: 'resources/notes.md'
    })
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.deepEqual(loaded.versioning, versioning)
    assert.deepEqual(requests, [
      'http://test/api/workbench/open?path=resources%2Fnotes.md&project=project',
      'http://test/api/workbench/content?path=resources%2Fnotes.md&project=project'
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
    scholarseed: { getApiBase: () => 'http://test' }
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
          pending: ['binary_preview_unsupported']
        },
        media_type: 'application/octet-stream',
        size: 4,
        revision: 'sha256:opaque'
      })
    }
    const loaded = await loadDocument(SOURCE)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.viewer, 'unsupported')
    assert.equal(loaded.bytes.byteLength, 0)
    assert.deepEqual(requests, [
      'http://test/api/v1/literatures/paper/attachments/figure/open'
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('readonly literature spreadsheets request shared compatibility preview bytes', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
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
            pending: ['spreadsheet_complex_content']
          },
          media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 4,
          revision: 'sha256:sheet'
        })
      }
      return new Response(new Uint8Array([80, 75, 3, 4]))
    }
    const loaded = await loadDocument(SOURCE)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.deepEqual(requests, [
      'http://test/api/v1/literatures/paper/attachments/figure/open',
      'http://test/api/v1/literatures/paper/attachments/figure/content?preview=true'
    ])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('literature attachments commit bytes through their exact identity and revision', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' }
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
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    const cases = [
      { path: 'notes.txt', mediaType: 'text/plain', viewer: 'code' },
      {
        path: 'script.py',
        mediaType: 'text/x-python',
        viewer: 'code'
      },
      {
        path: 'data.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        viewer: 'spreadsheet'
      }
    ] as const
    for (const entry of cases) {
      globalThis.fetch = async () => new Response('artifact', {
        headers: {
          'Content-Type': entry.mediaType,
          'X-ScholarSeed-Artifact-Editable': 'true'
        }
      })
      const source: SessionArtifactSource = {
        kind: 'session-artifact',
        sessionId: 'session',
        artifactId: 'artifact',
        path: entry.path,
        revision: 'sha256:old-publication'
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
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  const source: SessionArtifactSource = {
    kind: 'session-artifact', sessionId: 'session', artifactId: 'artifact', path: 'report.md'
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
    scholarseed: { getApiBase: () => 'http://test' }
  } as Window & typeof globalThis
  try {
    globalThis.fetch = async () => Response.json(
      {
        detail: {
          code: 'literature_attachment_unreadable',
          message: '附件当前无法读取',
          retryable: true
        }
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
      status: 422
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('citation-opened PDFs annotate through the cited literature attachment, or report no record owner', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  const citation = { answerId: 'answer', answerRevision: 'answer-1', handle: 'handle' }
  const cited: SessionFileSource = { kind: 'session-file', sessionId: 'session', path: 'paper', mediaType: 'application/pdf', citation, recordTarget: SOURCE.recordTarget }
  const attachment: SessionFileSource = { kind: 'session-file', sessionId: 'session', path: 'attachments/paper.pdf', mediaType: 'application/pdf', citation }
  const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
  const snapshot: PdfRecordSnapshot = { record_target: SOURCE.recordTarget, source_revision: 'source-1', record_revision: 'records-1', source_state: 'available', source_path: '', records }
  const requested: string[] = []
  try {
    globalThis.fetch = async url => {
      requested.push(String(url))
      return String(url).endsWith('/records')
        ? Response.json(snapshot)
        : new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'Content-Type': 'application/pdf' } })
    }
    const loaded = await loadDocument(cited)
    if (isDocumentLoadFailure(loaded)) assert.fail(loaded.code)
    assert.equal(loaded.capabilities.can_annotate, true)
    assert.equal((await loadPdfRecords(cited))?.record_revision, 'records-1')
    assert.equal(requested.at(-1), 'http://test/api/v1/literatures/paper/attachments/figure/records')

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
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  const project = { kind: 'project' as const, project: 'linked-project', path: 'resources/linked.pdf', assetId: 'linked-asset' }
  const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
  const snapshot: PdfRecordSnapshot = { record_target: SOURCE.recordTarget, source_revision: 'source-1', record_revision: 'records-1', source_state: 'available', source_path: '', records }
  let updated: PdfRecordSnapshot | undefined
  let unsubscribe = (): void => {}
  try {
    globalThis.fetch = async (_url, init) => Response.json(init?.method === 'PUT' ? { ...snapshot, record_revision: 'records-2' } : snapshot)
    await loadPdfRecords(project)
    await loadPdfRecords(SOURCE)
    unsubscribe = subscribePdfRecords(SOURCE, value => { updated = value })
    await commitPdfRecords(project, records, snapshot.record_revision, snapshot.source_revision)
    assert.equal(updated?.record_revision, 'records-2')
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('focus refresh delivers annotations saved by another window', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let focused: (() => void) | undefined
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://test' },
    addEventListener: (_event: string, callback: () => void) => { focused = callback },
    removeEventListener: () => {}
  } as unknown as Window & typeof globalThis
  const records = { schema_version: 1 as const, marks: [], comments: [], notes: [] }
  let snapshot: PdfRecordSnapshot = { record_target: SOURCE.recordTarget, source_revision: 'source-1', record_revision: 'external-1', source_state: 'available', source_path: '', records }
  let unsubscribe = (): void => {}
  try {
    globalThis.fetch = async () => Response.json(snapshot)
    await loadPdfRecords(SOURCE)
    const changed = new Promise<PdfRecordSnapshot>(resolve => { unsubscribe = subscribePdfRecords(SOURCE, resolve) })
    snapshot = { ...snapshot, record_revision: 'external-2' }
    focused?.()
    assert.equal((await changed).record_revision, 'external-2')
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
