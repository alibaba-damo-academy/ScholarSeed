import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AssistantContextCandidate,
  AssistantContextTarget,
  AssistantIngress,
} from '../../contracts/assistant.ts'
import type { SelectionAnchor } from '../../contracts/workbench.ts'
import type { DocumentSession, DocumentWorkspace } from './workspace.ts'
import { addPdfCommentContext, addSelectionContext } from './context.ts'
import { digestText, documentIdFor } from './api.ts'
import type { PdfRecordSnapshot } from '../../contracts/workbench.ts'

test('artifact PDF selections retain session and member identity with a frozen snapshot', async () => {
  const received: AssistantContextCandidate[] = []
  const target = { sessionId: 'conversation', projectId: 'project', draftScope: 1 }
  const ingress = {
    captureContextTarget: () => target,
    addContext: async (candidate: AssistantContextCandidate, captured: AssistantContextTarget) => {
      assert.equal(captured, target)
      received.push(candidate)
      return { accepted_ref_ids: ['selection'] }
    },
    openPanel: () => {},
  } as unknown as AssistantIngress
  const selection = {
    text: 'Selected artifact text\nsecond line',
    locator: { kind: 'pdf', page: 1, quads: [[0.1, 0.1, 0.5, 0.2]] },
  } as SelectionAnchor
  for (const memberPath of [undefined, 'reports/report.pdf']) {
    const session = {
      title: 'report.pdf',
      revision: 'sha256:artifact',
      source: {
        kind: 'session-artifact',
        sessionId: 'origin',
        artifactId: 'publication',
        path: '/not/a/project/path.pdf',
        memberPath,
      },
    } as DocumentSession
    assert.equal(
      await addSelectionContext(session, selection, {} as DocumentWorkspace, ingress),
      null
    )
    const candidate = received.at(-1)!
    assert.equal(candidate.kind, 'selection')
    assert.equal(candidate.source_id, documentIdFor(session.source))
    assert.equal(candidate.source_revision, session.revision)
    assert.equal(candidate.anchor?.snapshot_text, selection.text)
    assert.equal(candidate.anchor?.selected_text_hash, await digestText(selection.text))
  }
  assert.notEqual(received[0].source_id, received[1].source_id)
})

test('PDF preparation and original-selection hashing retain the click target across project and draft switches', async () => {
  const originalFetch = globalThis.fetch
  const originalTarget = { sessionId: null, projectId: 'project-a', draftScope: 0 }
  const session = {
    revision: 'source',
    title: 'Paper',
    source: { kind: 'literature', literatureId: 'paper', attachmentId: 'pdf' },
  } as DocumentSession
  const snapshot = {
    record_target: { owner: 'literature_attachment', scope_id: 'paper', subject_id: 'pdf' },
    record_revision: 'records',
    source_revision: 'source',
  } as PdfRecordSnapshot
  const selection = {
    text: 'original evidence',
    locator: { kind: 'pdf', page: 1, quads: [[0, 0, 1, 1]] },
  } as SelectionAnchor
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  try {
    for (const nextTarget of [
      { ...originalTarget, projectId: 'project-b' },
      { ...originalTarget, draftScope: 1 },
    ]) {
      let currentTarget = originalTarget
      let captures = 0
      let release!: () => void
      let opened = false
      let batch: readonly AssistantContextCandidate[] = []
      const ingress = {
        captureContextTarget: () => {
          captures += 1
          return currentTarget
        },
        addContexts: async (
          candidates: readonly AssistantContextCandidate[],
          expected: AssistantContextTarget
        ) => {
          assert.deepEqual(expected, originalTarget)
          batch = candidates
          assert.notDeepEqual(expected, currentTarget)
          return { accepted_ref_ids: [], rejected: [{ code: 'context_save_failed' }] }
        },
        openPanel: () => {
          opened = true
        },
      } as unknown as AssistantIngress
      globalThis.fetch = () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(
                JSON.stringify({
                  refs: [{ kind: 'pdf_comment', source_id: 'comment', label: 'PDF' }],
                }),
                { status: 200 }
              )
            )
        })
      const pending = addPdfCommentContext(
        session,
        snapshot,
        'mark',
        selection,
        {} as DocumentWorkspace,
        ingress
      )
      currentTarget = nextTarget
      release()
      assert.equal(await pending, false)
      assert.equal(captures, 1)
      assert.equal(batch.length, 2)
      assert.equal(batch[0].anchor?.snapshot_text, 'original evidence')
      assert.equal(opened, false)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('PDF comment context prepares canonical refs, appends one batch and never sends', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  })
  const candidate: AssistantContextCandidate = {
    kind: 'pdf_comment',
    source_id: 'opaque-comment',
    source_revision: 'record-version',
    label: 'PDF · 1',
    retention: 'next_turn',
    origin: 'explicit',
  }
  const requests: unknown[] = []
  const batches: AssistantContextCandidate[][] = []
  const session = {
    revision: 'source',
    source: { kind: 'literature', literatureId: 'paper', attachmentId: 'pdf' },
    title: 'Paper',
  } as DocumentSession
  const snapshot = {
    record_target: { owner: 'literature_attachment', scope_id: 'paper', subject_id: 'pdf' },
    record_revision: 'record-version',
    source_revision: 'source',
  } as PdfRecordSnapshot
  let accepted = true
  const ingress = {
    captureContextTarget: () => ({ sessionId: null, projectId: null, draftScope: 0 }),
    addContexts: async (candidates: AssistantContextCandidate[]) => {
      batches.push(candidates)
      return {
        accepted_ref_ids: accepted ? ['ref'] : [],
        rejected: accepted ? [] : [{ code: 'unavailable' }],
      }
    },
    openPanel: () => {},
  } as unknown as AssistantIngress
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/workbench/pdf-comments/prepare')
    requests.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ refs: [candidate] }), { status: 200 })
  }
  try {
    assert.equal(
      await addPdfCommentContext(
        session,
        snapshot,
        'point',
        null,
        {} as DocumentWorkspace,
        ingress
      ),
      true
    )
    assert.deepEqual(batches, [[candidate]])
    assert.deepEqual(requests, [
      {
        record_target: snapshot.record_target,
        mark_id: 'point',
        record_revision: 'record-version',
        source_revision: 'source',
      },
    ])
    const selection = {
      text: 'original evidence',
      locator: { kind: 'pdf', page: 1, quads: [[0, 0, 1, 1]] },
    } as SelectionAnchor
    assert.equal(
      await addPdfCommentContext(
        session,
        snapshot,
        'mark',
        selection,
        {} as DocumentWorkspace,
        ingress
      ),
      true
    )
    assert.equal(batches[1].length, 2)
    assert.equal(batches[1][0].anchor?.snapshot_text, 'original evidence')
    assert.equal(batches[1][1].kind, 'pdf_comment')
    assert.equal(batches[1][1].anchor, undefined)
    accepted = false
    assert.equal(
      await addPdfCommentContext(
        session,
        snapshot,
        'point',
        null,
        {} as DocumentWorkspace,
        ingress
      ),
      false
    )
    globalThis.fetch = async () => new Response('', { status: 409 })
    const before = batches.length
    assert.equal(
      await addPdfCommentContext(
        session,
        snapshot,
        'point',
        null,
        {} as DocumentWorkspace,
        ingress
      ),
      false
    )
    assert.equal(batches.length, before)
  } finally {
    globalThis.fetch = originalFetch
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('shared text context keeps the full PDF anchor and appends without sending', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events: Event[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event)
      },
    },
  })
  try {
    const session = {
      id: 'viewer',
      documentId: 'document',
      revision: 'source',
      title: 'Paper',
      dirty: false,
      source: {
        kind: 'literature',
        literatureId: 'paper',
        attachmentId: 'attachment',
        path: 'paper.pdf',
      },
    } as DocumentSession
    const selection: SelectionAnchor = {
      document_id: 'document',
      document_session_id: 'viewer',
      revision: 'source',
      status: 'exact',
      text: 'complete source\nsecond line',
      locator: {
        kind: 'pdf',
        page: 3,
        quads: [
          [0.1, 0.2, 0.3, 0.4],
          [0.1, 0.5, 0.3, 0.6],
        ],
        text_length: 27,
      },
    }
    const received: AssistantContextCandidate[] = []
    const panels: string[] = []
    const ingress = {
      captureContextTarget: () => ({ sessionId: null, projectId: null, draftScope: 0 }),
      addContext: async (candidate: AssistantContextCandidate) => {
        received.push(candidate)
        return { accepted_ref_ids: ['ref'] }
      },
      openPanel: (reason: string) => panels.push(reason),
    } as unknown as AssistantIngress
    const result = await addSelectionContext(session, selection, {} as DocumentWorkspace, ingress)
    assert.equal(result, null)
    assert.equal(received.length, 1)
    assert.equal(received[0].kind, 'literature')
    assert.equal(received[0].source_id, 'paper')
    assert.equal(received[0].source_revision, 'source')
    assert.equal(received[0].retention, 'next_turn')
    assert.deepEqual(received[0].anchor, {
      document_id: 'attachment',
      locator: { ...selection.locator, text_shape_hash: await digestText(selection.text) },
      selected_text_hash: await digestText(selection.text),
      preview_text: selection.text,
      snapshot_text: selection.text,
    })
    assert.deepEqual(panels, ['context_added'])
    assert.equal(events.length, 0, 'adding PDF text preserves the selection toolbar focus')
    const failed = await addSelectionContext(session, selection, {} as DocumentWorkspace, {
      ...ingress,
      addContext: async () => {
        throw Error('offline')
      },
    })
    assert.equal(failed, 'selectionActions.contextAddFailed')
    assert.equal(
      events.length,
      0,
      'failed PDF context additions preserve the selection toolbar focus'
    )
    assert.deepEqual(panels, ['context_added'])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('shared context commits dirty project state before recording its current revision', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: () => true },
  })
  try {
    const order: string[] = []
    const session = {
      id: 'viewer',
      revision: 'draft',
      dirty: true,
      title: 'Resource',
      source: { kind: 'project', project: 'project', path: 'resource.md' },
    } as DocumentSession
    const selection: SelectionAnchor = {
      document_id: 'doc',
      document_session_id: 'viewer',
      revision: 'draft',
      status: 'exact',
      text: 'selected',
      locator: { kind: 'text', start_line: 1, start_column: 1, end_line: 1, end_column: 9 },
    }
    const controller = {
      save: async () => {
        order.push('save')
        return true
      },
      getSnapshot: () => ({
        sessions: { viewer: { ...session, dirty: false, revision: 'saved' } },
      }),
    } as unknown as DocumentWorkspace
    const ingress = {
      captureContextTarget: () => ({ sessionId: null, projectId: null, draftScope: 0 }),
      addContext: async (candidate: AssistantContextCandidate) => {
        order.push(candidate.source_revision!)
        return { accepted_ref_ids: ['ref'] }
      },
      openPanel: () => {},
    } as unknown as AssistantIngress
    assert.equal(await addSelectionContext(session, selection, controller, ingress), null)
    assert.deepEqual(order, ['save', 'saved'])
    order.length = 0
    assert.equal(
      await addSelectionContext(
        session,
        selection,
        { ...controller, save: async () => false } as unknown as DocumentWorkspace,
        ingress
      ),
      'selectionActions.contextSaveFailed'
    )
    assert.deepEqual(order, [])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
