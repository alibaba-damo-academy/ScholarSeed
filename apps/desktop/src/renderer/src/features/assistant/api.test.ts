import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import { AssistantRequestError } from './failure.ts'
import zh from '../../../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../../../localization/locales/en/assistant.json' with { type: 'json' }

import {
  BACKEND_ADMISSION_FAILURE,
  BACKEND_FAILURE_EVENT,
  postTurn,
  sendQueuedMessage
} from '../../api.ts'
import type { AssistantContextSelection } from '../../contracts/assistant.ts'
import type { CitationResolution } from '../../contracts/citations.ts'
import {
  citationPreviewUrl,
  CitationResolveError,
  createAnswerAnnotation,
  deleteAnswerAnnotation,
  deleteAnswerAnnotations,
  resolveCitation,
  createResourceFromAssistant,
  fetchArtifactSha256,
  fetchLiteratureCandidates,
  fetchResourceCandidatePage,
  fetchResourceCandidates,
  fetchResourceDirectoryTree,
  fetchResourceFolderCandidates,
  fetchSessionReferencePreview,
  isUnverifiableCitationError,
  SessionReferencePreviewError,
  getAssistantContext,
  getAssistantInvocation,
  importArtifactToResources,
  importAttachmentToResources,
  listAnswerAnnotations,
  listArtifactResourceLinks,
  listArtifactLibraryLinks,
  patchAssistantContext,
  resourceContextSearchTerm,
  resourceContextTriggerPath,
  removeAnswerAnnotationContext,
  saveAnswerSelectionToResource,
  startAssistantInvocation,
  startAssistantSelectionAction,
  startAssistantTranslation,
  updateAnswerAnnotation
} from './api.ts'

test('citation preview URL carries only the authorized saved receipt identity', () => {
  const source = {
    answer_session_id: 'session /一', answer_id: 'answer/1', answer_revision: 'sha256:answer',
    handle: 'handle/1', presentation: { page: 7 }
  } as CitationResolution
  const restore = installBrowser(async () => Response.json({}))
  try {
    assert.equal(
      citationPreviewUrl(source),
      'http://service.test/api/assistant/sessions/session%20%2F%E4%B8%80/answers/answer%2F1/citations/handle%2F1/preview?answer_revision=sha256%3Aanswer&page=7'
    )
  } finally { restore() }
})

test('citation resolution distinguishes an invented handle from a transient load failure', async () => {
  const restore = installBrowser(async () => Response.json(
    { detail: 'citation_evidence_unavailable' },
    { status: 409 }
  ))
  try {
    await assert.rejects(
      resolveCitation('session', 'answer:1', `sha256:${'a'.repeat(64)}`, 0, 0, 'invented'),
      (error: unknown) => {
        assert.ok(error instanceof CitationResolveError)
        assert.equal(error.code, 'citation_evidence_unavailable')
        assert.equal(isUnverifiableCitationError(error), true)
        return true
      }
    )
    assert.equal(isUnverifiableCitationError(new Error('network_error')), false)
  } finally { restore() }
})

test('session reference preview stays scoped to the sent snapshot and carries its cursor', async () => {
  let requested = ''
  let credentials: RequestCredentials | undefined
  const response = {
    title: '原对话',
    messages: [{ message_id: 'message-1', role: 'user' as const, text: '问题' }],
    changed: false,
    has_more: true,
    next_cursor: 'next-page'
  }
  const restore = installBrowser(async (url, options) => {
    requested = String(url)
    credentials = options?.credentials
    return Response.json(response)
  })
  try {
    assert.deepEqual(
      await fetchSessionReferencePreview('current/session', 'snapshot/id', 'source/session', 'cursor/value'),
      response
    )
    assert.equal(
      requested,
      'http://service.test/api/assistant/sessions/current%2Fsession/context/snapshot%2Fid/session-preview?source_id=source%2Fsession&cursor=cursor%2Fvalue'
    )
    assert.equal(credentials, 'include')
  } finally {
    restore()
  }
})

test('sent attachment import uses session reference identity and destination, not a client path', async () => {
  let requestUrl = ''
  let requestBody: unknown
  const restore = installBrowser(async (url, init) => {
    requestUrl = String(url)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ node: { name: 'report.pdf', path: 'resources/report.pdf' } }))
  })
  try {
    const result = await importAttachmentToResources('session/1', 'project-1', 'local-file-1', {
      parent: ' 报告 ', name: ' report.pdf '
    })
    assert.equal(result.ok, true)
    assert.equal(requestUrl, 'http://service.test/api/assistant/sessions/session%2F1/resources/attachment')
    assert.deepEqual(requestBody, {
      project_id: 'project-1', reference_id: 'local-file-1', location: { parent: '报告', name: 'report.pdf' }
    })
  } finally {
    restore()
  }
})

const ANNOTATION = {
  annotation_id: 'annotation-1',
  client_annotation_id: 'client-annotation-1',
  session_id: 'session-1',
  answer_id: 'answer:12',
  source_product_seq: 12,
  source_turn_id: 'turn-1',
  source_item_id: 'item-1',
  answer_revision: `sha256:${'a'.repeat(64)}`,
  start_utf16: 1,
  end_utf16: 3,
  selected_text_hash: `sha256:${'b'.repeat(64)}`,
  preview_text: '选区',
  comment: '备注',
  revision: 1,
  created_at: 1,
  updated_at: 1
}

const CONTEXT: AssistantContextSelection = {
  session_id: 'session-1',
  revision: 2,
  project_policy: 'explicit_only',
  search_scope: 'academic',
  refs: [],
  updated_at: 10,
  capabilities: []
}

function installBrowser(fetcher: typeof fetch): () => void {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  globalThis.fetch = fetcher
  return () => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

test('artifact library links are session-scoped and failed queries never become empty success', async () => {
  let requested = ''
  let credentials: RequestCredentials | undefined
  let response = Response.json({ links: [] })
  const restore = installBrowser(async (url, options) => {
    requested = String(url)
    credentials = options?.credentials
    return response
  })
  try {
    assert.deepEqual(await listArtifactResourceLinks('session/links'), { ok: true, links: [] })
    assert.equal(requested, 'http://service.test/api/assistant/sessions/session%2Flinks/resources/links')
    assert.equal(credentials, 'include')
    response = Response.json({ detail: 'forbidden' }, { status: 403 })
    assert.deepEqual(await listArtifactResourceLinks('session/links'), { ok: false, error: 'http_403' })
    response = Response.json({})
    assert.deepEqual(await listArtifactResourceLinks('session/links'), { ok: false, error: 'invalid_response' })
  } finally {
    restore()
  }
})

test('artifact library aggregation preserves both destinations and reports a failed destination', async () => {
  const requests: string[] = []
  let failLiterature = false
  const resource = { destination: 'resources', link_id: 'resource-link' }
  const literature = { destination: 'literature', link_id: 'literature-link' }
  const restore = installBrowser(async (url, options) => {
    requests.push(String(url))
    assert.equal(options?.credentials, 'include')
    if (String(url).endsWith('/resources/links')) return Response.json({ links: [resource] })
    return failLiterature
      ? Response.json({ detail: 'unavailable' }, { status: 503 })
      : Response.json({ links: [literature] })
  })
  try {
    assert.deepEqual(await listArtifactLibraryLinks('session/links'), { ok: true, links: [resource, literature] })
    assert.equal(requests[1], 'http://service.test/api/assistant/sessions/session%2Flinks/literature/links')
    failLiterature = true
    assert.deepEqual(await listArtifactLibraryLinks('session/links'), { ok: false, error: 'http_503' })
  } finally {
    restore()
  }
})

test('loads the Session-owned Assistant context with credentials', async () => {
  let captured = ''
  let credentials: RequestCredentials | undefined
  const restore = installBrowser(async (input, init) => {
    captured = String(input)
    credentials = init?.credentials
    return Response.json(CONTEXT)
  })
  try {
    assert.deepEqual(await getAssistantContext('session-1'), CONTEXT)
    assert.equal(captured, 'http://service.test/api/assistant/sessions/session-1/context')
    assert.equal(credentials, 'include')
  } finally {
    restore()
  }
})

test('returns the authoritative latest selection after a CAS conflict', async () => {
  const restore = installBrowser(async () => Response.json({
    detail: {
      error: 'assistant_context_revision_conflict',
      latest: CONTEXT
    }
  }, { status: 409 }))
  try {
    const result = await patchAssistantContext('session-1', {
      expected_revision: 1,
      project_policy: 'explicit_only',
      search_scope: 'web',
      refs: []
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'assistant_context_revision_conflict')
    assert.deepEqual(result.latest, CONTEXT)
  } finally {
    restore()
  }
})

test('answer annotations use their dedicated persisted context endpoints', async () => {
  const observed: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = []
  const restore = installBrowser(async (input, init) => {
    observed.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    })
    if (!init?.method) return Response.json({ annotations: [ANNOTATION] })
    if (init.method === 'POST') {
      return Response.json({ annotation: ANNOTATION, selection: CONTEXT })
    }
    if (init.method === 'PATCH') {
      return Response.json({
        annotation: { ...ANNOTATION, comment: '修改后', revision: 2 },
        selection: CONTEXT
      })
    }
    return Response.json(CONTEXT)
  })
  try {
    assert.deepEqual(await listAnswerAnnotations('session-1'), [ANNOTATION])
    const created = await createAnswerAnnotation('session-1', 'answer:12', {
      client_annotation_id: 'client-annotation-1',
      expected_context_revision: 2,
      answer_revision: ANNOTATION.answer_revision,
      start_utf16: 1,
      end_utf16: 3,
      selected_text_hash: ANNOTATION.selected_text_hash,
      preview_text: '选区',
      comment: '备注',
      enqueue: true
    })
    const updated = await updateAnswerAnnotation('session-1', 'annotation-1', {
      expected_annotation_revision: 1,
      expected_context_revision: 3,
      comment: '修改后'
    })
    const removed = await removeAnswerAnnotationContext('session-1', 'annotation-1', 3)
    const deleted = await deleteAnswerAnnotation('session-1', 'annotation-1', 2, 3)
    const batchDeleted = await deleteAnswerAnnotations('session-1', {
      expected_context_revision: 3,
      annotations: [
        { annotation_id: 'annotation-1', expected_annotation_revision: 2 },
        { annotation_id: 'annotation-2', expected_annotation_revision: 1 }
      ]
    })
    assert.equal(created.annotation?.annotation_id, 'annotation-1')
    assert.equal(updated.annotation?.comment, '修改后')
    assert.equal(removed.context?.revision, 2)
    assert.equal(deleted.context?.revision, 2)
    assert.equal(batchDeleted.context?.revision, 2)
    assert.deepEqual(observed.map((item) => [item.method, item.url]), [
      [undefined, 'http://service.test/api/assistant/sessions/session-1/annotations'],
      ['POST', 'http://service.test/api/assistant/sessions/session-1/answers/answer%3A12/annotations'],
      ['PATCH', 'http://service.test/api/assistant/sessions/session-1/annotations/annotation-1'],
      ['DELETE', 'http://service.test/api/assistant/sessions/session-1/annotations/annotation-1/context'],
      ['DELETE', 'http://service.test/api/assistant/sessions/session-1/annotations/annotation-1'],
      ['DELETE', 'http://service.test/api/assistant/sessions/session-1/annotations']
    ])
    assert.deepEqual(observed[2].body, {
      expected_annotation_revision: 1,
      expected_context_revision: 3,
      comment: '修改后'
    })
    assert.equal(observed[3].body?.expected_context_revision, 3)
    assert.deepEqual(observed[4].body, {
      expected_annotation_revision: 2,
      expected_context_revision: 3
    })
    assert.deepEqual(observed[5].body, {
      expected_context_revision: 3,
      annotations: [
        { annotation_id: 'annotation-1', expected_annotation_revision: 2 },
        { annotation_id: 'annotation-2', expected_annotation_revision: 1 }
      ]
    })
  } finally {
    restore()
  }
})

test('turn admission carries a stable client id and acknowledged context revision', async () => {
  let body: Record<string, unknown> = {}
  const restore = installBrowser(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ ok: true, turn_id: 'turn-1' }, { status: 202 })
  })
  try {
    await postTurn(
      'session-1',
      [{ type: 'text', text: '用户原问题' }],
      'default',
      { clientUserMessageId: 'client-1', assistantContextRevision: 2 }
    )
    assert.deepEqual(body, {
      input: [{ type: 'text', text: '用户原问题' }],
      collaboration_mode: 'default',
      wait: false,
      client_user_message_id: 'client-1',
      assistant_context_revision: 2
    })
  } finally {
    restore()
  }
})

test('rejected message admission is scoped separately from an active turn failure', async () => {
  const failures: CustomEvent[] = []
  const restore = installBrowser(async () => (
    Response.json({ error: 'resource_queue_full' }, { status: 503 })
  ))
  window.dispatchEvent = (event: Event): boolean => {
    failures.push(event as CustomEvent)
    return true
  }
  try {
    const initial = await postTurn('session-1', [{ type: 'text', text: '新消息' }], 'default', {
      clientUserMessageId: 'client-2'
    })
    const queued = await sendQueuedMessage('session-1', 'client-2')
    assert.equal(initial?.ok, false)
    assert.equal(queued?.ok, false)
    assert.equal(failures.length, 1)
    for (const failure of failures) {
      assert.equal(failure.type, BACKEND_FAILURE_EVENT)
      assert.equal(failure.detail.sessionId, 'session-1')
      assert.equal(failure.detail.scope, BACKEND_ADMISSION_FAILURE)
    }
  } finally {
    restore()
  }
})

test('preserves structured Assistant context issues for the admission UI', async () => {
  const failures: CustomEvent[] = []
  const restore = installBrowser(async () => Response.json({
    error: 'assistant_context_unavailable',
    detail: 'assistant_context_unavailable',
    issues: [{
      ref_id: 'selection-1',
      kind: 'selection',
      label: 'evidence.md · 划词',
      state: 'stale',
      reason: 'selection_text_changed'
    }]
  }, { status: 400 }))
  window.dispatchEvent = (event: Event): boolean => {
    failures.push(event as CustomEvent)
    return true
  }
  try {
    const result = await postTurn(
      'session-1',
      [{ type: 'text', text: '分析一下' }],
      'default',
      { clientUserMessageId: 'client-context', assistantContextRevision: 1 }
    )
    assert.equal(result?.error, 'assistant_context_unavailable')
    assert.equal(result?.issues?.[0]?.reason, 'selection_text_changed')
    assert.equal(failures[0]?.detail.code, 'assistant_context_unavailable')
    assert.equal(failures[0]?.detail.issues[0].label, 'evidence.md · 划词')
  } finally {
    restore()
  }
})

test('creates an AI response resource through the session-scoped business API', async () => {
  let captured = ''
  let body: Record<string, unknown> = {}
  const restore = installBrowser(async (input, init) => {
    captured = String(input)
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      node: { path: 'resources/ai_extracts/结论.md', name: '结论.md', kind: 'file' }
    })
  })
  try {
    const result = await createResourceFromAssistant('session/1', '结论', '# 结论', {
      projectId: 'project-1'
    })
    assert.equal(result.ok, true)
    assert.equal(result.node?.path, 'resources/ai_extracts/结论.md')
    assert.equal(
      captured,
      'http://service.test/api/assistant/sessions/session%2F1/resources/create'
    )
    assert.deepEqual(body, { project_id: 'project-1', name: '结论', content: '# 结论' })
  } finally {
    restore()
  }
})

test('generic and translation calls use distinct authenticated Assistant endpoints', async () => {
  const observed: Array<{ url: string; body: Record<string, unknown>; credentials?: RequestCredentials }> = []
  const restore = installBrowser(async (input, init) => {
    observed.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      credentials: init?.credentials
    })
    return Response.json({
      invocation_id: `invocation-${observed.length}`,
      client_action_id: String(observed.at(-1)?.body.client_action_id),
      client_attempt_id: String(observed.at(-1)?.body.client_attempt_id),
      retry_of_attempt_id: null,
      kind: observed.length === 1 ? 'complete' : 'translate',
      project_id: 'project-1',
      source: { source_id: '', source_revision: null },
      prompt_version: observed.length === 1 ? 'one-shot/v1' : 'translate/v2',
      status: 'completed',
      detected_source_language: null,
      target_language: observed.length === 1 ? '' : 'zh-CN',
      model_key: 'model-1',
      output: { type: 'text', text: 'result' },
      usage: { input_tokens: 1, output_tokens: 1, receipt_id: 'receipt-1' },
      error: null,
      created_at: 1,
      updated_at: 2
    })
  })
  try {
    const completion = await startAssistantInvocation({
      client_action_id: 'action-1',
      client_attempt_id: 'attempt-1',
      project_id: 'project-1',
      input_text: 'Summarize this.',
      instructions: 'Return one sentence.'
    })
    const translation = await startAssistantTranslation({
      client_action_id: 'action-2',
      client_attempt_id: 'attempt-2',
      project_id: 'project-1',
      text: 'explicit selected text',
      target_language: 'ja',
      source_id: 'paper.pdf'
    })

    assert.equal(completion.ok, true)
    assert.equal(translation.ok, true)
    assert.deepEqual(observed.map((row) => row.url), [
      'http://service.test/api/assistant/invocations',
      'http://service.test/api/assistant/translations'
    ])
    assert.equal(observed[0].credentials, 'include')
    assert.equal(observed[1].body.text, 'explicit selected text')
    assert.equal(observed[1].body.target_language, 'ja')
    assert.equal('source_language' in observed[1].body, false)
  } finally {
    restore()
  }
})

test('imports a session artifact by stable id without sending an absolute path', async () => {
  let body: Record<string, unknown> = {}
  const restore = installBrowser(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      node: { path: 'resources/ai_extracts/result.csv', name: 'result.csv', kind: 'file' }
    })
  })
  try {
    const result = await importArtifactToResources('session-1', 'artifact-1', {
      projectId: 'project-1'
    })
    assert.equal(result.ok, true)
    assert.deepEqual(body, { project_id: 'project-1', artifact_id: 'artifact-1' })
    assert.equal('path' in body, false)
  } finally {
    restore()
  }
})

test('selection action transport stays inside Assistant and preserves verified evidence identity', async () => {
  let body: Record<string, unknown> = {}
  const restore = installBrowser(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      action: 'interpret',
      status: 'completed',
      prompt_version: 'scholarseed.selection.interpret/codex-v2',
      output: 'result',
      invocation_id: 'invocation-1',
      client_action_id: 'action-1',
      client_attempt_id: 'attempt-1',
      retry_of_attempt_id: null,
      error_code: '',
      evidence: {}
    })
  })
  try {
    const result = await startAssistantSelectionAction({
      action: 'interpret',
      client_action_id: 'action-1',
      client_attempt_id: 'attempt-1',
      project_id: 'project-a',
      source_id: 'notes/evidence.md',
      source_revision: 'sha256:revision',
      selection: {
        locator: {
          kind: 'markdown',
          start: 4,
          end: 21,
          source_map_version: 'md-source-v1'
        },
        selected_text_hash: 'sha256:selected',
        preview_text: 'display only'
      },
      question: '为什么？'
    })
    assert.equal(result.ok, true)
    assert.equal(body.action, 'interpret')
    assert.equal(body.client_action_id, 'action-1')
    assert.equal(body.client_attempt_id, 'attempt-1')
    assert.deepEqual(body.selection, {
      project_id: 'project-a',
      source_id: 'notes/evidence.md',
      source_revision: 'sha256:revision',
      locator_kind: 'markdown',
      selected_text_hash: 'sha256:selected',
      locator: {
        kind: 'markdown',
        start: 4,
        end: 21,
        source_map_version: 'md-source-v1'
      }
    })
  } finally {
    restore()
  }
})

test('selection stream renders fragmented Unicode before authoritative final and rejects missing terminal', async () => {
  const input = {
    action: 'translate' as const, client_action_id: 'action', client_attempt_id: 'attempt',
    project_id: 'project', source_id: 'text.md', source_revision: 'revision',
    selection: { locator: { kind: 'markdown' as const, start: 0, end: 1, source_map_version: 'v1' },
      selected_text_hash: 'hash', preview_text: 'text' }
  }
  const activity = { type: 'output_delta', invocation_id: 'id', text: '中文预览', item_id: 'item' }
  const encoder = new TextEncoder()
  let finish: () => void = () => {}
  let controller: ReadableStreamDefaultController<Uint8Array>
  const restore = installBrowser(async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Accept, 'text/event-stream')
    return new Response(new ReadableStream({ start(value) {
      controller = value
      const bytes = encoder.encode(`: heartbeat\r\n\r\ndata: ${JSON.stringify(activity)}\r\n\r\n`)
      for (const byte of bytes) value.enqueue(Uint8Array.of(byte))
    } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    const observed: string[] = []
    const ready = new Promise<void>((resolve) => { finish = resolve })
    const pending = startAssistantSelectionAction(input, { onEvent(event) { observed.push(event.text); finish() } })
    await ready
    assert.deepEqual(observed, ['中文预览'])
    controller!.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'result', result: {
      ...input, invocation_id: 'id', output: '校准结果', status: 'completed'
    } })}\n\n`))
    controller!.close()
    const result = await pending
    assert.equal(result.ok && result.result.output, '校准结果')
    const incomplete = startAssistantSelectionAction(input, { onEvent() { controller.close() } })
    assert.deepEqual(await incomplete, { ok: false, error: 'selection_stream_incomplete' })
  } finally { restore() }
})

test('selection action transports an explicit transient draft without replacing evidence identity', async () => {
  let body: Record<string, unknown> = {}
  const restore = installBrowser(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      action: 'polish', status: 'completed', prompt_version: 'scholarseed.selection.polish/codex-v1',
      output: '润色结果', invocation_id: 'invocation-draft', client_action_id: 'action-draft',
      client_attempt_id: 'attempt-draft', retry_of_attempt_id: null, error_code: '', evidence: {}
    })
  })
  try {
    const draft = {
      change_version: 4,
      selected_text: '未保存原文',
      context_text: '未保存上下文',
      selected_text_hash: 'sha256:draft'
    }
    const result = await startAssistantSelectionAction({
      action: 'polish', client_action_id: 'action-draft', client_attempt_id: 'attempt-draft',
      project_id: 'project-a', source_id: 'notes/draft.md', source_revision: 'sha256:base',
      selection: {
        locator: { kind: 'markdown', start: 0, end: 5, source_map_version: 'md-source-v1' },
        selected_text_hash: 'sha256:draft', preview_text: '未保存原文'
      },
      draft
    })
    assert.equal(result.ok, true)
    assert.deepEqual(body.draft, draft)
    assert.equal((body.selection as Record<string, unknown>).source_revision, 'sha256:base')
  } finally {
    restore()
  }
})

test('invocation status lookup returns only a successful response payload', async () => {
  let requestUrl = ''
  const restore = installBrowser(async (input) => {
    requestUrl = String(input)
    return new Response(null, { status: 404 })
  })
  try {
    assert.equal(await getAssistantInvocation('missing invocation'), null)
    assert.equal(
      requestUrl,
      'http://service.test/api/assistant/invocations/missing%20invocation'
    )
  } finally {
    restore()
  }
})

test('artifact import sends stable identity, expected revision and resource-relative target', async () => {
  let requestUrl = ''
  let requestBody: Record<string, unknown> = {}
  const restore = installBrowser(async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      node: {
        path: 'resources/ai_extracts/report.md',
        name: 'report.md',
        kind: 'file',
        origin: 'local'
      }
    })
  })
  try {
    const result = await importArtifactToResources(
      'session/1',
      'artifact/1',
      {
        projectId: 'project-1',
        expectedSha256: 'a'.repeat(64),
        location: { parent: ' 阶段 ', name: ' report.md ' }
      }
    )
    assert.equal(result.ok, true)
    assert.equal(
      requestUrl,
      'http://service.test/api/assistant/sessions/session%2F1/resources/import'
    )
    assert.deepEqual(requestBody, {
      project_id: 'project-1',
      artifact_id: 'artifact/1',
      expected_sha256: 'a'.repeat(64),
      location: { parent: '阶段', name: 'report.md' }
    })
  } finally {
    restore()
  }
})

test('artifact import refreshes the current edited revision through the raw HEAD contract', async () => {
  const currentSha256 = 'b'.repeat(64)
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const restore = installBrowser(async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(null, { headers: { ETag: `"sha256:${currentSha256}"` } })
  })
  try {
    assert.equal(await fetchArtifactSha256('session/edited', 'artifact/edited'), currentSha256)
    assert.equal(
      requestUrl,
      'http://service.test/api/serve/sessions/session%2Fedited/artifacts/artifact%2Fedited/raw'
    )
    assert.equal(requestInit?.method, 'HEAD')
    assert.equal(requestInit?.credentials, 'include')
    assert.equal(requestInit?.cache, 'no-store')
  } finally {
    restore()
  }
})

test('artifact revision refresh rejects missing or malformed revision headers', async () => {
  const restore = installBrowser(async () => new Response(null, { headers: { ETag: 'stale' } }))
  try {
    assert.equal(await fetchArtifactSha256('session', 'artifact'), null)
  } finally {
    restore()
  }
})

test('answer selection save keeps provenance in SQL metadata instead of markdown', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { assistant: zh }, en: { assistant: en } } })
  const t = locale.getFixedT(null, 'assistant')
  let requestUrl = ''
  let requestBody: Record<string, unknown> = {}
  const restore = installBrowser(async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      node: {
        path: 'resources/ai_extracts/回答摘录.md',
        name: '回答摘录.md',
        kind: 'file',
        origin: 'local'
      }
    })
  })
  try {
    const result = await saveAnswerSelectionToResource({
      sessionId: 'session/1',
      projectId: 'project-1',
      answerId: 'answer:12',
      answerRevision: `sha256:${'a'.repeat(64)}`,
      startUtf16: 7,
      endUtf16: 19,
      selectedTextHash: `sha256:${'b'.repeat(64)}`,
      selectedMarkdown: '**选择的回答**',
      question: '原始研究问题是什么？',
      location: { parent: '研究设计/结论', name: '低仰角结论' }
    }, t)

    assert.equal(result.ok, true)
    assert.equal(
      requestUrl,
      'http://service.test/api/assistant/sessions/session%2F1/resources/create'
    )
    assert.equal(requestBody.name, '低仰角结论')
    assert.deepEqual(requestBody.source, {
      answer_id: 'answer:12',
      answer_revision: `sha256:${'a'.repeat(64)}`,
      start_utf16: 7,
      end_utf16: 19,
      selected_text_hash: `sha256:${'b'.repeat(64)}`
    })
    assert.deepEqual(requestBody.location, {
      parent: '研究设计/结论',
      name: '低仰角结论'
    })
    const content = String(requestBody.content)
    assert.equal(content.startsWith('# 低仰角结论\n'), true)
    assert.doesNotMatch(content, /scholarseed-answer-selection/)
    assert.match(content, /## 原问题\n\n原始研究问题是什么？/)
    assert.match(content, /\*\*选择的回答\*\*/)
  } finally {
    restore()
  }
})

test('resource save directory tree is scoped to the session project', async () => {
  let requestUrl = ''
  const restore = installBrowser(async (input) => {
    requestUrl = String(input)
    return Response.json({
      root: '/project/resources',
      nodes: [{
        path: 'resources/reports',
        name: 'reports',
        kind: 'dir',
        count: 1,
        children: [{
          path: 'resources/reports/archive',
          name: 'archive',
          kind: 'dir',
          count: 0,
          children: []
        }]
      }]
    })
  })
  try {
    const tree = await fetchResourceDirectoryTree('project/1')
    assert.equal(
      requestUrl,
      'http://service.test/api/resource/tree?project=project%2F1'
    )
    assert.deepEqual(tree, [{
      path: 'resources/reports',
      name: 'reports',
      kind: 'dir',
      count: 1,
      children: [{
        path: 'resources/reports/archive',
        name: 'archive',
        kind: 'dir',
        count: 0,
        children: []
      }]
    }])
  } finally {
    restore()
  }
})

test('resource and literature endpoints become prototype context candidates', async () => {
  const observed: string[] = []
  const restore = installBrowser(async (input) => {
    const url = String(input)
    observed.push(url)
    if (url.includes('/api/resource/tree')) {
      return Response.json({
        root: '/project',
        nodes: [
          { path: 'resources/计划.md', name: '计划.md', kind: 'file' },
          { path: 'resources/数据', name: '数据', kind: 'dir' }
        ]
      })
    }
    return Response.json({
      items: [{
        id: 'paper-1',
        title: 'GPT-4 Technical Report',
        creators_display: 'OpenAI',
        publication_display: 'arXiv',
        year: 2023
      }]
    })
  })
  try {
    const resources = await fetchResourceFolderCandidates('project-1', '')
    const literature = await fetchLiteratureCandidates('project-1', 'GPT-4')

    assert.deepEqual(resources, [
      {
        kind: 'file',
        source_id: 'resources/计划.md',
        label: '计划.md',
        hint: 'doc',
        retention: 'next_turn',
        origin: 'explicit'
      },
      {
        kind: 'dir',
        source_id: 'resources/数据',
        label: '数据',
        hint: 'folder',
        retention: 'next_turn',
        origin: 'explicit'
      }
    ])
    assert.deepEqual(literature, [{
      kind: 'literature',
      source_id: 'paper-1',
      label: 'GPT-4 Technical Report',
      hint: 'OpenAI · 2023',
      retention: 'next_turn',
      origin: 'explicit'
    }])
    assert.match(observed[0], /\/api\/resource\/tree\?project=project-1&depth=1$/)
    assert.match(observed[1], /\/api\/v1\/literatures\?page=1&page_size=200&project_id=project-1&q=GPT-4$/)
  } finally {
    restore()
  }
})

test('flat resource candidates page through the complete scope and filter by filename', async () => {
  const observed: URL[] = []
  const restore = installBrowser(async (input) => {
    const url = new URL(String(input))
    observed.push(url)
    return url.searchParams.has('cursor')
      ? Response.json({
          items: [{ path: 'resources/deep/report.md', size: 2, created_at: 20 }],
          next_cursor: null
        })
      : Response.json({
          items: [{ path: 'resources/ignored.txt', size: 1, created_at: 10 }],
          next_cursor: 'resources/ignored.txt'
        })
  })
  try {
    const candidates = await fetchResourceCandidates('project-1', 'report')
    assert.equal(observed.length, 2)
    assert.equal(observed[1].searchParams.get('cursor'), 'resources/ignored.txt')
    assert.deepEqual(candidates, [{
      kind: 'file',
      source_id: 'resources/deep/report.md',
      label: 'report.md',
      hint: 'resources/deep/report.md',
      created_at: 20,
      retention: 'next_turn',
      origin: 'explicit'
    }])
  } finally {
    restore()
  }
})

test('folder expansion keeps project-relative paths and follows server pagination', async () => {
  const observed: URL[] = []
  const restore = installBrowser(async (input, init) => {
    observed.push(new URL(String(input)))
    assert.equal(init?.credentials, 'include')
    const offset = Number(observed.at(-1)?.searchParams.get('offset') ?? 0)
    return Response.json({
      nodes: [{ path: `resources/数据 & 分析/${offset}.md`, name: `${offset}.md`, kind: 'file' }],
      total: 2,
      offset
    })
  })
  try {
    const first = await fetchResourceCandidatePage('project-1', 'resources/数据 & 分析')
    assert.equal(first?.nextOffset, 1)
    assert.equal(first?.items[0].source_id, 'resources/数据 & 分析/0.md')
    assert.equal(first?.items[0].retention, 'next_turn')
    const last = await fetchResourceCandidatePage('project-1', 'resources/数据 & 分析', first!.nextOffset!)
    assert.equal(last?.nextOffset, null)
    assert.equal(last?.items[0].source_id, 'resources/数据 & 分析/1.md')
    assert.equal(observed[0].searchParams.get('project'), 'project-1')
    assert.equal(observed[0].searchParams.get('path'), 'resources/数据 & 分析')
    assert.equal(observed[0].searchParams.get('depth'), '1')
    assert.equal(observed[1].searchParams.get('offset'), '1')
  } finally {
    restore()
  }
})

test('resource @ picker enters folders and filters only the visible directory leaf', async () => {
  const observed: URL[] = []
  const restore = installBrowser(async (input) => {
    observed.push(new URL(String(input)))
    return Response.json({
      nodes: [
        { path: 'resources/数据/分析报告.md', name: '分析报告.md', kind: 'file' },
        { path: 'resources/数据/原始数据.csv', name: '原始数据.csv', kind: 'file' }
      ]
    })
  })
  try {
    const candidates = await fetchResourceFolderCandidates('project-1', '数据/分析')
    assert.equal(observed[0].searchParams.get('path'), '数据')
    assert.deepEqual(candidates.map((item) => item.label), ['分析报告.md'])
    assert.equal(resourceContextSearchTerm('数据/分析'), '分析')
    assert.equal(resourceContextSearchTerm('数据/'), '')
    assert.equal(resourceContextTriggerPath('resources/数据/子目录'), '数据/子目录')
  } finally {
    restore()
  }
})

test('resource @ picker follows a linked legacy folder without assuming a managed root', async () => {
  const observed: URL[] = []
  const restore = installBrowser(async (input) => {
    observed.push(new URL(String(input)))
    return Response.json({
      nodes: [{ path: 'arxiv_papers/paper.md', name: 'paper.md', kind: 'file' }]
    })
  })
  try {
    const candidates = await fetchResourceFolderCandidates('project-1', 'arxiv_papers/')
    assert.equal(observed[0].searchParams.get('path'), 'arxiv_papers')
    assert.deepEqual(candidates.map((item) => item.source_id), ['arxiv_papers/paper.md'])
    assert.equal(candidates[0]?.retention, 'next_turn')
  } finally {
    restore()
  }
})

test('global assistant candidates expose global literature and never request project resources', async () => {
  const observed: URL[] = []
  const restore = installBrowser(async (input) => {
    observed.push(new URL(String(input)))
    return Response.json({ items: [] })
  })
  try {
    assert.deepEqual(await fetchResourceFolderCandidates(null, ''), [])
    assert.deepEqual(await fetchLiteratureCandidates(null, 'agent'), [])
    assert.equal(observed.length, 1)
    assert.equal(observed[0].pathname, '/api/v1/literatures')
    assert.equal(observed[0].searchParams.get('q'), 'agent')
    assert.equal(observed[0].searchParams.has('project_id'), false)
  } finally {
    restore()
  }
})

test('folder load failure remains distinguishable from an empty folder', async () => {
  const restore = installBrowser(async () => Response.json({}, { status: 403 }))
  try {
    assert.equal(await fetchResourceCandidatePage('project-1', 'resources/失效目录'), null)
  } finally {
    restore()
  }
})


test('new answer excerpts localize only their template while retaining content and request identity', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { assistant: zh }, en: { assistant: en } } })
  const t = locale.getFixedT(null, 'assistant')
  const requests: Array<Record<string, unknown>> = []
  const restore = installBrowser(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ node: { path: 'resources/原文.md', name: '原文.md' } })
  })
  const input = {
    sessionId: 'session-1', projectId: 'project-1', answerId: 'answer-1',
    answerRevision: 'original-revision', startUtf16: 3, endUtf16: 12,
    selectedTextHash: 'original-hash', selectedMarkdown: '**AI原文**\n\n`code`',
    question: '用户原文 {{question}}', location: { parent: '中文目录', name: '原文.md' }
  }
  const original = JSON.stringify(input)
  try {
    await saveAnswerSelectionToResource(input, t)
    const savedChinese = JSON.stringify(requests[0])
    await locale.changeLanguage('en')
    await saveAnswerSelectionToResource(input, t)
    const { content: chineseContent, ...chineseRequest } = requests[0]
    const { content: englishContent, ...englishRequest } = requests[1]
    assert.deepEqual(englishRequest, chineseRequest)
    assert.equal(englishContent, '# 原文\n\n> ScholarSeed Agent answer excerpt\n\n## Original question\n\n用户原文 {{question}}\n\n## Excerpt\n\n**AI原文**\n\n`code`\n')
    assert.ok(String(chineseContent).includes('## 原问题'))
    assert.equal(JSON.stringify(requests[0]), savedChinese)
    assert.equal(JSON.stringify(input), original)
  } finally {
    restore()
  }
})


test('preview application failures have a stable identity while upstream diagnostics remain original', async () => {
  const responses = [
    new Response('unavailable', { status: 503 }),
    Response.json({}, { status: 500 }),
    Response.json({ title: 'malformed successful preview' }),
    Response.json('unexpected JSON string'),
    Response.json(42),
    Response.json(true),
    Response.json(null),
    Response.json({ detail: 'request failed' }, { status: 503 }),
    Response.json({ detail: 'assistant_session_preview_failed' }, { status: 503 }),
    Response.json({ detail: '原始诊断 <detail> & 保留' }, { status: 409 })
  ]
  const restore = installBrowser(async () => responses.shift()!)
  try {
    for (let index = 0; index < 7; index++) {
      await assert.rejects(fetchSessionReferencePreview('session', 'snapshot', 'source'), (error: unknown) => {
        assert.ok(error instanceof SessionReferencePreviewError)
        assert.equal(error.code, 'assistant_session_preview_failed')
        return true
      })
    }
    for (const detail of ['request failed', 'assistant_session_preview_failed', '原始诊断 <detail> & 保留']) {
      await assert.rejects(fetchSessionReferencePreview('session', 'snapshot', 'source'), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error instanceof SessionReferencePreviewError, false)
        assert.equal(error.message, detail)
        return true
      })
    }
  } finally {
    restore()
  }
})


test('assistant mutation adapters identify every locally generated request fallback without changing upstream messages', async () => {
  const calls = [
    () => createAnswerAnnotation('session', 'answer', {
      client_annotation_id: 'annotation', expected_context_revision: 1,
      answer_revision: 'revision', start_utf16: 0, end_utf16: 1,
      selected_text_hash: 'hash', preview_text: '原文', comment: '', enqueue: true
    }),
    () => updateAnswerAnnotation('session', 'annotation', {
      expected_annotation_revision: 1, expected_context_revision: 1, comment: '原文'
    }),
    () => removeAnswerAnnotationContext('session', 'annotation', 1),
    () => deleteAnswerAnnotation('session', 'annotation', 1, 1),
    () => deleteAnswerAnnotations('session', {
      expected_context_revision: 1,
      annotations: [{ annotation_id: 'annotation', expected_annotation_revision: 1 }]
    }),
    () => patchAssistantContext('session', { expected_revision: 1, project_policy: 'explicit_only', search_scope: 'web', refs: [] }),
    () => importAttachmentToResources('session', 'project', 'attachment', { parent: '', name: 'original.pdf' }),
    () => startAssistantTranslation({ client_action_id: 'action', client_attempt_id: 'attempt', project_id: 'project', text: '原文', target_language: 'en' }),
    () => startAssistantSelectionAction({
      action: 'translate', client_action_id: 'action', client_attempt_id: 'attempt',
      project_id: 'project', source_id: 'text.md', source_revision: 'revision',
      selection: { locator: { kind: 'markdown', start: 0, end: 1, source_map_version: 'v1' }, selected_text_hash: 'hash', preview_text: '原文' }
    })
  ]
  for (const cause of [undefined, new Error('request failed'), new Error('request_failed')]) {
    const restore = installBrowser(async () => { throw cause })
    try {
      for (const call of calls) {
        const result = await call()
        assert.equal(result.ok, false)
        assert.deepEqual(result, cause instanceof Error
          ? { ok: false, error: cause.message }
          : { ok: false, error: 'request_failed', applicationFailure: { code: 'request_failed' } })
      }
    } finally { restore() }
  }
})


test('citation resolution distinguishes local missing-detail failures from matching upstream diagnostic strings', async () => {
  const responses = [Response.json({}, { status: 503 }), Response.json({ detail: 'request_failed' }, { status: 503 })]
  const restore = installBrowser(async () => responses.shift()!)
  try {
    await assert.rejects(resolveCitation('s', 'a', 'r', 0, 1), (error: unknown) => {
      assert.ok(error instanceof AssistantRequestError)
      assert.deepEqual(error.applicationFailure, { code: 'request_failed' })
      return true
    })
    await assert.rejects(resolveCitation('s', 'a', 'r', 0, 1), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error instanceof AssistantRequestError, false)
      assert.equal(error.message, 'request_failed')
      return true
    })
  } finally { restore() }
})
