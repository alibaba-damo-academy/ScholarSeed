import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createPreviewService } from './service.ts'
import { hasAcceptedMessageAwaitingRuntime, optimisticQueuedMessage, settleOptimisticQueuedMessage } from '../src/renderer/src/queue.ts'
import { DEFAULT_PROJECT_LAYOUT } from '../src/layout.ts'
import { resolveContentResponse } from '../src/renderer/src/app/api/content.ts'
import { PROJECT_NAME_MAX } from '../src/renderer/src/contracts/content.ts'
import { ProjectSimulation } from './project.ts'
import { PREVIEW_DIAGNOSTIC_LIMIT } from './diagnostics.ts'
import { PREVIEW_DOCUMENTS } from './documents.ts'
import { resolveDocumentLocation, loadDocument } from '../src/renderer/src/features/workbench/api.ts'
import { fetchVersionCapability, fetchResourceVersions, fetchResourceVersionContent, sealResourceSnapshot, fetchResourceAgentOrigin, fetchResourceReviewBatchForPath, fetchReviewMemberContent, fetchReviewMemberCurrent, decideResourceReviewBatch } from '../src/renderer/src/features/resources/api.ts'
import { versionDiffTab, parseVersionDiffTab } from '../src/renderer/src/features/workbench/tabs.ts'
import { createPreviewBridge } from './bridge.ts'
import { submitFeedback, listQueuedMessages, getBackendHealth, deleteSession, setSessionArchived, listAllSessions, getHistoryWithTodos } from '../src/renderer/src/api.ts'
import { loadTrashHistory, loadWorkspaceRoot, saveWorkspaceRoot, listProjects, setProjectArchived, forgetProject, listExternalRoots, selectExternalRootProject } from '../src/renderer/src/features/project/api.ts'
import { listArtifactLibraryLinks, getAssistantContext, listAnswerAnnotations } from '../src/renderer/src/features/assistant/api.ts'
import { listLiteratureSearches, loadSearchLibraryStatus } from '../src/renderer/src/features/literature/api.ts'
import { projectOfficialWebSearch } from '../src/renderer/src/features/resources/search.ts'
import { PREVIEW_SEARCH } from './searches.ts'
import { loadFileVersionSettings, waitForFileVersionScan, saveFileVersionSettings } from '../src/renderer/src/features/resources/settings.ts'
import { accountBase, accountMe, ERR_UNAUTHENTICATED, setAccountBase, listApiKeys, createApiKey, revokeApiKey, rotateApiKey } from '../src/renderer/src/account.ts'
import { previewAccountBase } from './accounts.ts'
import { readPreviewAccountState } from './bridge.ts'
import { getSharedRuntimeReconfiguration, currentRuntimeReconfiguration } from '../src/renderer/src/api.ts'
import { getModelProviders, getPersonalApiProfiles, getModels, setPersonalApiProfileEnabled } from '../src/renderer/src/api.ts'
import { PREVIEW_MODELS, PREVIEW_MODEL_SAMPLE } from './models.ts'
import { PREVIEW_FILE_SETTINGS } from './configuration.ts'
import { PREVIEW_STORAGE } from './storage.ts'
import { PREVIEW_STORAGE_READ } from './directory.ts'
import { PREVIEW_BROWSING } from './listing.ts'
import { PREVIEW_CONTENT } from './content.ts'
import { PREVIEW_PROJECT_ID } from './constants.ts'
import { PREVIEW_ARCHIVE } from './archive.ts'
import { PREVIEW_BROWSER } from './browser.ts'
import { PREVIEW_ROOTS_PATH } from './roots.ts'
import { PREVIEW_CONVERSATION } from './conversation.ts'
import { PREVIEW_ARTIFACTS } from './publications.ts'
import { projectStreamDelta } from '../src/renderer/src/transcript.ts'
import type { ConvItem } from '../src/renderer/src/model.ts'
import type { ProductEvent } from '../src/renderer/src/api.ts'
import { listAllLiteratures, getLiterature, getLiteratureCounts, getLiteratureTagFacets, updateLiterature, listLiteratureNotes, addLiteratureNote, updateLiteratureNote, deleteLiteratureNote } from '../src/renderer/src/features/literature/api.ts'

const CONVERSATION_POLL_MS = 10
const CONVERSATION_STATE_TIMEOUT_MS = 3_000

async function replayR1Events(runtime: Awaited<ReturnType<typeof fixture>>, instance: string, session: string, expected: ProductEvent[], from = 0): Promise<ProductEvent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONVERSATION_STATE_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(`${runtime.base}/api/serve/sessions/${session}/events?from_seq=${from}&previewInstance=${instance}`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    reader = response.body!.getReader()
    const events: ProductEvent[] = []
    const decoder = new TextDecoder()
    let buffer = ''
    while (events.length < expected.length) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false, 'SSE must include every expected replay event')
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))
        if (!data || frame.startsWith('event: heartbeat')) continue
        const event = JSON.parse(data.slice('data: '.length)) as ProductEvent
        assert.equal(frame.split('\n').find(line => line.startsWith('id: ')), `id: ${event.seq}`)
        assert.equal(event.seq, from + events.length + 1)
        assert.equal(event.session_id, session)
        events.push(event)
      }
    }
    assert.deepEqual(events, expected)
    return events
  } finally {
    clearTimeout(timer)
    try { if (reader) await reader.cancel() } finally { controller.abort() }
  }
}

for (const toolPolicy of ['delayed', 'failed'] as const) {
  test(`R1 tool ${toolPolicy} preserves pending progress and completes the same tool and turn`, async () => {
    const runtime = await fixture()
    const instance = `r1-tool-${toolPolicy}`
    const session = 'preview-session'
    const scene = toolPolicy === 'failed' ? 'conversation-tool-failed' : 'conversation-tool-running'
    try {
      await runtime.request('/__preview/reset', instance, { scene, pageId: 'page-conversation' })
      const accepted = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'R1 tool lifecycle' }] })
      assert.equal(accepted.status, 200)
      const turnId = accepted.body.turn_id
      const deadline = performance.now() + CONVERSATION_STATE_TIMEOUT_MS
      let prefix
      do {
        prefix = (await runtime.request(`/api/serve/history/${session}`, instance)).body
        if (prefix.activity_events.some((event: ProductEvent) => event.type === 'tool_output_delta')) break
        assert.ok(performance.now() < deadline, 'Expected the first real tool output delta')
        await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
      } while (performance.now() < deadline)
      const pendingTool = prefix.turns.find((turn: { kind: string }) => turn.kind === 'tool')
      assert.equal(pendingTool.status, 'pending')
      assert.equal(pendingTool.turn_id, turnId)
      assert.equal(prefix.activity_events.filter((event: ProductEvent) => event.type === 'tool_completed').length, 0)
      const snapshot = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
      assert.equal(snapshot.running, true)
      assert.equal(snapshot.active_turn_id, turnId)
      assert.equal(snapshot.last_turn_status, 'running')
      await waitPreviewSession(runtime, instance, session, 'completed')
      const history = (await runtime.request(`/api/serve/history/${session}`, instance)).body
      const chunks = history.activity_events.filter((event: ProductEvent) => event.type === 'tool_output_delta')
      const completed = history.activity_events.filter((event: ProductEvent) => event.type === 'tool_completed')
      assert.deepEqual(chunks.map((event: { data: { delta: string } }) => event.data.delta), [...(toolPolicy === 'failed' ? PREVIEW_CONVERSATION.toolFailedOutputChunks : PREVIEW_CONVERSATION.toolOutputChunks)])
      assert.equal(completed.length, 1)
      assert.equal(completed[0].turn_id, turnId)
      assert.equal(completed[0].data.tool_id, pendingTool.item_id)
      assert.equal(completed[0].data.success, toolPolicy !== 'failed')
      const savedTool = history.turns.find((turn: { kind: string }) => turn.kind === 'tool')
      assert.equal(savedTool.item_id, pendingTool.item_id)
      assert.equal(savedTool.status, toolPolicy === 'failed' ? 'error' : 'done')
      assert.equal(savedTool.ok, toolPolicy !== 'failed')
      assert.equal(savedTool.output, chunks.map((event: { data: { delta: string } }) => event.data.delta).join(''))
      assert.equal(history.activity_events.filter((event: ProductEvent) => event.type === 'turn_completed').length, 1)
      assert.equal(history.activity_events.filter((event: ProductEvent) => event.type === 'turn_failed').length, 0)
      const events = history.activity_events as ProductEvent[]
      assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
      assert.ok(events.every(event => event.session_id === session && event.turn_id === turnId))
      const started = events.filter(event => event.type === 'tool_started')
      assert.equal(started.length, 1)
      assert.equal(started[0].data.name, PREVIEW_CONVERSATION.toolName)
      assert.deepEqual(started[0].data.input, PREVIEW_CONVERSATION.toolInput)
      for (const event of events) {
        if (event.type !== 'tool_started' && event.type !== 'tool_output_delta' && event.type !== 'tool_completed') continue
        assert.equal(event.item_id, savedTool.item_id)
        assert.equal(event.data.tool_id, savedTool.item_id)
      }
      assert.ok(started[0].seq < chunks[0].seq && chunks.at(-1).seq < completed[0].seq)
      assert.ok(history.turns.every((turn: { turn_id: string }) => turn.turn_id === turnId))
      const replay = await replayR1Events(runtime, instance, session, events)
      const cursor = chunks[0].seq
      await replayR1Events(runtime, instance, session, replay.filter(event => event.seq > cursor), cursor)
    } finally { runtime.close() }
  })
}

test('R1 interrupt after a tool prefix keeps partial cancelled history without late completion', async () => {
  const runtime = await fixture()
  const instance = 'r1-tool-interrupt'
  const session = 'preview-session'
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-tool-running', pageId: 'page-conversation' })
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Interrupt partial tool' }] })
    const deadline = performance.now() + CONVERSATION_STATE_TIMEOUT_MS
    let prefix
    do {
      prefix = (await runtime.request(`/api/serve/history/${session}`, instance)).body
      if (prefix.activity_events.some((event: ProductEvent) => event.type === 'tool_output_delta')) break
      assert.ok(performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() < deadline)
    assert.equal(prefix.activity_events.filter((event: ProductEvent) => event.type === 'tool_completed').length, 0)
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/interrupt`, instance, {})).status, 200)
    await waitPreviewSession(runtime, instance, session, 'interrupted')
    const cancelled = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    const tool = cancelled.turns.find((turn: { kind: string }) => turn.kind === 'tool')
    assert.equal(tool.status, 'cancelled')
    assert.equal(tool.output, PREVIEW_CONVERSATION.toolOutputChunks[0])
    const observeUntil = performance.now() + PREVIEW_CONVERSATION.toolRunMs
    do {
      const current = (await runtime.request(`/api/serve/history/${session}`, instance)).body
      assert.deepEqual(current.turns, cancelled.turns)
      assert.deepEqual(current.activity_events, cancelled.activity_events)
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() < observeUntil)
    assert.equal(cancelled.activity_events.filter((event: ProductEvent) => event.type === 'tool_completed').length, 0)
    assert.equal(cancelled.activity_events.filter((event: ProductEvent) => event.type === 'turn_interrupted').length, 1)
  } finally { runtime.close() }
})

test('R1 allowed HIL resumes the identical request and turn before its delayed answer', async () => {
  const runtime = await fixture()
  const instance = 'r1-hil-resume'
  const session = 'preview-session'
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-approval-resume', pageId: 'page-conversation' })
    const admitted = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Resume same approved turn' }] })
    const turnId = admitted.body.turn_id
    const deadline = performance.now() + CONVERSATION_STATE_TIMEOUT_MS
    let waiting
    do {
      waiting = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
      if (waiting.pending_hil.length) break
      assert.ok(performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() < deadline)
    const requestId = waiting.pending_hil[0].request_id
    const reply = await runtime.request(`/api/serve/sessions/${session}/hil/${requestId}`, instance, { option_id: 'y' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.request_id, requestId)
    assert.equal(reply.body.interaction.turn_id, turnId)
    assert.equal(reply.body.interaction.session_id, session)
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/hil/${requestId}`, instance, { option_id: 'y' })).status, 409)
    const resumed = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
    assert.equal(resumed.running, true)
    assert.equal(resumed.last_turn_status, 'running')
    assert.equal(resumed.active_turn_id, turnId)
    assert.deepEqual(resumed.pending_hil, [])
    const during = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.equal(during.activity_events.filter((event: ProductEvent) => ['message_delta', 'turn_completed'].includes(event.type)).length, 0)
    await waitPreviewSession(runtime, instance, session, 'completed')
    const completed = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.equal(completed.turns.filter((turn: { kind: string }) => turn.kind === 'user').length, 1)
    assert.equal(completed.activity_events.filter((event: ProductEvent) => event.type === 'turn_completed').length, 1)
    assert.ok(completed.activity_events.filter((event: ProductEvent) => event.type === 'message_delta').every((event: ProductEvent) => event.turn_id === turnId))
    assert.equal(completed.turns.find((turn: { role?: string }) => turn.role === 'assistant').text, PREVIEW_CONVERSATION.approvalAnswer)
    const events = completed.activity_events as ProductEvent[]
    assert.ok(events.every(event => event.session_id === session && event.turn_id === turnId))
    const requested = events.filter(event => event.type === 'hil_requested')
    const resolved = events.filter(event => event.type === 'hil_resolved')
    const terminals = events.filter(event => event.type === 'turn_completed')
    assert.equal(requested.length, 1)
    assert.equal(resolved.length, 1)
    assert.equal(requested[0].data.request_id, requestId)
    assert.equal(resolved[0].data.request_id, requestId)
    assert.equal(resolved[0].data.state, 'resolved')
    assert.equal(resolved[0].data.decision, 'allow_once')
    const running = events.find(event => event.type === 'session_state' && event.data.state === 'running' && event.seq > resolved[0].seq)
    assert.ok(running?.type === 'session_state')
    assert.equal(running.data.active_turn_id, turnId)
    assert.ok(requested[0].seq < resolved[0].seq && resolved[0].seq < running.seq && running.seq < terminals[0].seq)
    assert.ok(events.filter(event => event.type === 'message_delta').every(event => event.seq > running.seq))
    await replayR1Events(runtime, instance, session, events.filter(event => event.seq > requested[0].seq), requested[0].seq)
  } finally { runtime.close() }
})

test('R1 cancelled tool cannot append into the immediately following completed turn', async () => {
  const runtime = await fixture()
  const instance = 'r1-tool-next-turn'
  const session = 'preview-session'
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-tool-running', pageId: 'page-conversation' })
    const first = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Cancel this tool prefix' }] })
    const firstTurn = first.body.turn_id
    const deadline = performance.now() + CONVERSATION_STATE_TIMEOUT_MS
    let prefix
    do {
      prefix = (await runtime.request(`/api/serve/history/${session}`, instance)).body
      if (prefix.activity_events.some((event: ProductEvent) => event.type === 'tool_output_delta')) break
      assert.ok(performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() < deadline)
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/interrupt`, instance, {})).status, 200)
    const cancelled = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    const cancelledEvents = cancelled.activity_events.filter((event: ProductEvent) => event.turn_id === firstTurn)
    const cancelledTurns = cancelled.turns.filter((turn: { turn_id: string }) => turn.turn_id === firstTurn)
    const next = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Complete the next tool independently' }] })
    assert.equal(next.status, 200)
    assert.notEqual(next.body.turn_id, firstTurn)
    await waitPreviewSession(runtime, instance, session, 'completed')
    const saved = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.deepEqual(saved.activity_events.filter((event: ProductEvent) => event.turn_id === firstTurn), cancelledEvents)
    assert.deepEqual(saved.turns.filter((turn: { turn_id: string }) => turn.turn_id === firstTurn), cancelledTurns)
    const tools = saved.turns.filter((turn: { kind: string }) => turn.kind === 'tool')
    assert.equal(tools.length, 2)
    assert.equal(tools[0].status, 'cancelled')
    assert.equal(tools[0].output, PREVIEW_CONVERSATION.toolOutputChunks[0])
    assert.equal(tools[1].status, 'done')
    assert.equal(tools[1].turn_id, next.body.turn_id)
    assert.notEqual(tools[1].item_id, tools[0].item_id)
    assert.equal(tools[1].output, PREVIEW_CONVERSATION.toolOutput)
    const terminals = saved.activity_events.filter((event: ProductEvent) => event.type === 'turn_completed')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].turn_id, next.body.turn_id)
    await replayR1Events(runtime, instance, session, saved.activity_events)
  } finally { runtime.close() }
})

test('R1 stopped approval rejects its old request while a new approved turn completes independently', async () => {
  const runtime = await fixture()
  const instance = 'r1-hil-stop'
  const session = 'preview-session'
  async function waitingApproval() {
    const deadline = performance.now() + CONVERSATION_STATE_TIMEOUT_MS
    do {
      const snapshot = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
      if (snapshot.pending_hil.length) return snapshot
      assert.ok(performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() < deadline)
    assert.fail('Expected pending approval')
  }
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-approval-resume', pageId: 'page-conversation' })
    const first = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Stop this approval' }] })
    const pending = await waitingApproval()
    const oldRequest = pending.pending_hil[0].request_id
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/interrupt`, instance, {})).status, 200)
    const stopped = await waitPreviewSession(runtime, instance, session, 'interrupted')
    assert.deepEqual(stopped.pending_hil, [])
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/hil/${oldRequest}`, instance, { option_id: 'y' })).status, 409)
    const cancelled = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    const firstEvents = cancelled.activity_events.filter((event: ProductEvent) => event.turn_id === first.body.turn_id)
    assert.equal(firstEvents.filter((event: ProductEvent) => event.type === 'hil_resolved' && event.data.state === 'cancelled').length, 1)
    assert.equal(firstEvents.filter((event: ProductEvent) => event.type === 'turn_interrupted').length, 1)
    const next = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Approve the new turn' }] })
    const waiting = await waitingApproval()
    const newRequest = waiting.pending_hil[0].request_id
    assert.notEqual(newRequest, oldRequest)
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/hil/${oldRequest}`, instance, { option_id: 'y' })).status, 409)
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/hil/${newRequest}`, instance, { option_id: 'y' })).status, 200)
    await waitPreviewSession(runtime, instance, session, 'completed')
    const saved = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.deepEqual(saved.activity_events.filter((event: ProductEvent) => event.turn_id === first.body.turn_id), firstEvents)
    const answers = saved.turns.filter((turn: { role?: string }) => turn.role === 'assistant')
    assert.equal(answers.length, 1)
    assert.equal(answers[0].turn_id, next.body.turn_id)
    assert.equal(answers[0].text, PREVIEW_CONVERSATION.approvalAnswer)
    await replayR1Events(runtime, instance, session, saved.activity_events)
  } finally { runtime.close() }
})

test('R1 submission waits before admission and rejects concurrent turns without creating a queue', async () => {
  const runtime = await fixture()
  const instance = 'r1-submission'
  const session = 'preview-session'
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-submit-pending', pageId: 'page-conversation' })
    const arrived = once(runtime.server, 'request')
    let settled = false
    const accepted = runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Delayed admission' }] }).then(value => { settled = true; return value })
    await arrived
    const snapshot = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
    const history = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.equal(settled, false)
    assert.equal(snapshot.running, false)
    assert.equal(snapshot.active_turn_id, null)
    assert.deepEqual(history.turns, [])
    assert.deepEqual(history.activity_events, [])
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Must not duplicate' }] })).status, 409)
    const receipt = await accepted
    assert.equal(receipt.status, 200)
    assert.equal(receipt.body.accepted, true)
    await waitPreviewSession(runtime, instance, session, 'completed')
    const saved = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.equal(saved.turns.filter((turn: { kind: string }) => turn.kind === 'user').length, 1)
    assert.equal(saved.activity_events.filter((event: ProductEvent) => event.type === 'turn_completed').length, 1)
  } finally { runtime.close() }
})

for (const cancellation of ['reset', 'delete', 'interrupt', 'disconnect'] as const) {
  test(`R1 unaccepted submission ${cancellation} leaves no delayed turn or event`, async () => {
    const runtime = await fixture()
    const instance = `r1-submission-${cancellation}`
    const session = 'preview-session'
    const controller = new AbortController()
    try {
      await runtime.request('/__preview/reset', instance, { scene: 'conversation-submit-pending', pageId: 'page-conversation' })
      const arrived = once(runtime.server, 'request')
      const pending = fetch(`${runtime.base}/api/serve/sessions/${session}/turns?previewInstance=${instance}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: [{ type: 'text', text: 'Never admitted' }] }), signal: controller.signal })
      const [request, response] = await arrived
      assert.equal(request.method, 'POST')
      const empty = (await runtime.request(`/api/serve/history/${session}`, instance)).body
      assert.deepEqual(empty.turns, [])
      if (cancellation === 'reset') await runtime.request('/__preview/reset', instance, { scene: 'chat' })
      else if (cancellation === 'delete') assert.equal((await fetch(`${runtime.base}/api/serve/sessions/${session}?previewInstance=${instance}`, { method: 'DELETE' })).status, 200)
      else if (cancellation === 'interrupt') await runtime.request(`/api/serve/sessions/${session}/interrupt`, instance, {})
      else {
        const closed = once(response, 'close')
        const rejected = assert.rejects(pending, { name: 'AbortError' })
        controller.abort()
        await rejected
        await closed
      }
      if (cancellation !== 'disconnect') {
        const cancelled = await pending
        assert.equal(cancelled.status, 410)
        assert.deepEqual(await cancelled.json(), { code: PREVIEW_CONVERSATION.submissionCancelled })
      }
      const observeUntil = performance.now() + PREVIEW_CONVERSATION.submissionDelayMs
      do {
        const current = await runtime.request(`/api/serve/history/${session}`, instance)
        if (cancellation === 'delete') assert.equal(current.status, 404)
        else {
          assert.equal(current.status, 200)
          assert.deepEqual(current.body.turns, [])
          assert.deepEqual(current.body.activity_events, [])
        }
        await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
      } while (performance.now() < observeUntil)
      if (cancellation === 'disconnect' || cancellation === 'interrupt') {
        const retry = await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: 'Fresh legitimate retry' }] })
        assert.equal(retry.status, 200)
        await waitPreviewSession(runtime, instance, session, 'completed')
      }
    } finally { controller.abort(); runtime.close() }
  })
}

test('browsing pagination and recursive listing share VFS bytes and do not consume one another policies', async () => {
  const runtime = await fixture()
  const instance = 'browsing-pages'
  const tree = `/api/content/projects/${PREVIEW_PROJECT_ID}/tree`
  const project = `project=${PREVIEW_PROJECT_ID}`
  try {
    assert.equal((await runtime.request('/__preview/reset', instance, { scene: 'browsing-more-failed', pageId: 'viewer-explorer' })).status, 200)
    const first = await runtime.request(`${tree}?path=&offset=0`, instance)
    assert.equal(first.status, 200)
    assert.equal(first.body.nodes.length, PREVIEW_BROWSING.pageSize)
    assert.ok(first.body.total > PREVIEW_BROWSING.pageSize)
    assert.equal(first.body.nodes[0].kind, 'dir')
    const auxiliary = await runtime.request(`/api/resource/tree?${project}&offset=${PREVIEW_BROWSING.pageSize}`, instance)
    assert.equal(auxiliary.status, 200)
    assert.ok(auxiliary.body.nodes.length > 0)
    assert.equal(auxiliary.body.offset, PREVIEW_BROWSING.pageSize)
    const failed = await runtime.request(`${tree}?path=&offset=${PREVIEW_BROWSING.pageSize}`, instance)
    assert.deepEqual(failed, { status: 503, body: { detail: PREVIEW_BROWSING.moreFailure } })
    assert.deepEqual((await runtime.request(`${tree}?path=&offset=0`, instance)).body, first.body)
    const second = await runtime.request(`${tree}?path=&offset=${PREVIEW_BROWSING.pageSize}`, instance)
    assert.equal(second.status, 200)
    const combined = [...first.body.nodes, ...second.body.nodes]
    assert.equal(combined.length, first.body.total)
    assert.equal(new Set(combined.map(node => node.path)).size, first.body.total)
    const end = await runtime.request(`${tree}?offset=${first.body.total + PREVIEW_BROWSING.pageSize}`, instance)
    assert.equal(end.body.offset, first.body.total)
    assert.deepEqual(end.body.nodes, [])
    const listing = (await runtime.request(`/api/resource/list?${project}`, instance)).body.items as { path: string; kind: 'file' | 'dir'; count: number | null; file_type: string; updated_at: number | null }[]
    for (const nested of PREVIEW_BROWSING.seed.nested) {
      assert.ok(listing.some(node => node.path === nested.path))
      const before = (await runtime.request(`/api/workbench/open?${project}&path=${encodeURIComponent(nested.path)}`, instance)).body
      const raw = await fetch(`${runtime.base}/api/resource/raw?${project}&path=${encodeURIComponent(nested.path)}`, { headers: { 'x-preview-instance': instance } })
      assert.equal(await raw.text(), nested.text)
      const after = (await runtime.request(`/api/workbench/open?${project}&path=${encodeURIComponent(nested.path)}`, instance)).body
      assert.equal(after.asset_id, before.asset_id)
      assert.equal(after.revision, before.revision)
    }
    assert.ok(listing.some(node => node.kind === 'dir' && node.path === 'preview-docs' && node.count === 2 && node.file_type === 'dir'))
    assert.equal(listing.find(node => node.path === 'preview-docs')?.updated_at, null)
    assert.equal(listing.find(node => node.path === 'preview-docs/nested/guide.md')?.file_type, 'MD')
    assert.equal((await runtime.request(`/api/resource/count?${project}`, instance)).body.files, listing.filter(node => node.kind === 'file').length)
  } finally { runtime.close() }
})

test('browsing empty seed is a real empty VFS without breaking global bootstrap or other instances', async () => {
  const runtime = await fixture()
  const instance = 'browsing-empty'
  try {
    assert.equal((await runtime.request('/__preview/reset', instance, { scene: 'browsing-empty', pageId: 'viewer-material-list' })).status, 200)
    assert.equal((await runtime.request('/__preview/state', instance)).status, 200)
    assert.deepEqual((await runtime.request(`/api/resource/list?project=${PREVIEW_PROJECT_ID}`, instance)).body.items, [])
    const tree = (await runtime.request(`/api/content/projects/${PREVIEW_PROJECT_ID}/tree`, instance)).body
    assert.equal(tree.total, 0)
    assert.deepEqual(tree.nodes, [])
    assert.equal((await runtime.request(`/api/workbench/open?project=${PREVIEW_PROJECT_ID}&path=readme.md`, instance)).status, 404)
    assert.ok((await runtime.request(`/api/resource/list?project=${PREVIEW_PROJECT_ID}`, 'other-browsing')).body.items.length > 0)
    assert.equal((await runtime.request('/api/content/projects/unknown/tree', instance)).status, 404)
  } finally { runtime.close() }
})

test('browsing read faults remain independent and persistent until explicit instance recovery', async () => {
  const runtime = await fixture()
  const instance = 'browsing-fault'
  const list = `/api/resource/list?project=${PREVIEW_PROJECT_ID}`
  const tree = `/api/content/projects/${PREVIEW_PROJECT_ID}/tree`
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'browsing-listing-failed', pageId: 'viewer-material-list' })
    for (const attempt of ['initial', 'retry']) {
      assert.deepEqual(await runtime.request(list, instance), { status: 503, body: { detail: PREVIEW_BROWSING.listingFailure } }, attempt)
      assert.equal((await runtime.request(tree, instance)).status, 200)
      assert.equal((await runtime.request(`/api/resource/tree?project=${PREVIEW_PROJECT_ID}`, instance)).status, 200)
    }
    assert.equal((await runtime.request(PREVIEW_BROWSING.recoveryPath, 'other-browsing', {})).status, 409)
    await runtime.request(PREVIEW_BROWSING.recoveryPath, instance, {})
    assert.equal((await runtime.request(list, instance)).status, 200)
    await runtime.request('/__preview/reset', instance, { scene: 'browsing-explorer-failed', pageId: 'viewer-explorer' })
    assert.equal((await runtime.request(tree, instance)).status, 503)
    assert.equal((await runtime.request(list, instance)).status, 200)
    await runtime.request(PREVIEW_BROWSING.recoveryPath, instance, {})
    assert.equal((await runtime.request(tree, instance)).status, 200)
    assert.equal((await runtime.request(PREVIEW_BROWSING.recoveryPath, 'other-browsing', {})).status, 409)
  } finally { runtime.close() }
})

test('browsing delayed reads cancel on reset and disconnect without changing the replacement project', async () => {
  const runtime = await fixture()
  const instance = 'browsing-read-wait'
  const reset = () => runtime.request('/__preview/reset', instance, { scene: 'browsing-explorer-pending', pageId: 'viewer-explorer' })
  const path = `/api/content/projects/${PREVIEW_PROJECT_ID}/tree`
  const get = (signal?: AbortSignal) => fetch(runtime.base + path, { headers: { 'x-preview-instance': instance }, signal })
  try {
    await reset()
    const arrived = once(runtime.server, 'request')
    const waiting = get()
    await arrived
    assert.equal((await runtime.request(`/api/resource/list?project=${PREVIEW_PROJECT_ID}`, instance)).status, 200)
    await reset()
    const cancelled = await waiting
    assert.equal(cancelled.status, 410)
    assert.deepEqual(await cancelled.json(), { detail: PREVIEW_BROWSING.disposed })
    const controller = new AbortController()
    const connection = once(runtime.server, 'request')
    const disconnected = get(controller.signal)
    const accepted = await connection
    const closed = once(accepted[1], 'close')
    const rejected = assert.rejects(disconnected, { name: 'AbortError' })
    controller.abort()
    await rejected
    await closed
    assert.equal((await get()).status, 200)
    assert.equal((await runtime.request(`/api/resource/list?project=${PREVIEW_PROJECT_ID}`, instance)).body.items.length, PREVIEW_DOCUMENTS.length)
  } finally { runtime.close() }
})

test('storage read policies isolate both sources and require explicit recovery before original retry', async () => {
  const runtime = await fixture()
  const instance = 'storage-reads'
  try {
    const seeded = await runtime.request('/__preview/reset', instance, { scene: 'settings-storage-home-read-failed', pageId: 'settings-storage' })
    assert.equal(seeded.status, 200)
    assert.ok(seeded.body.storage.config.home)
    for (const attempt of ['initial', 'retry']) {
      const failed = await runtime.request(PREVIEW_STORAGE_READ.configPath, instance)
      assert.deepEqual(failed, { status: 503, body: { detail: PREVIEW_STORAGE_READ.failure } }, attempt)
      assert.equal((await runtime.request(PREVIEW_STORAGE.path, instance)).status, 200)
    }
    assert.equal((await runtime.request(PREVIEW_STORAGE_READ.configPath, 'storage-other')).status, 200)
    assert.equal((await runtime.request(PREVIEW_STORAGE_READ.recoveryPath, 'storage-other', {})).status, 409)
    assert.equal((await runtime.request(PREVIEW_STORAGE_READ.recoveryPath, instance, {})).status, 200)
    assert.deepEqual((await runtime.request(PREVIEW_STORAGE_READ.configPath, instance)).body, seeded.body.storage.config)
    await runtime.request('/__preview/reset', instance, { scene: 'settings-storage-both-read-failed', pageId: 'settings-storage' })
    assert.equal((await runtime.request(PREVIEW_STORAGE_READ.configPath, instance)).status, 503)
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, instance)).status, 503)
    await runtime.request(PREVIEW_STORAGE_READ.recoveryPath, instance, {})
    assert.equal((await runtime.request(PREVIEW_STORAGE_READ.configPath, instance)).status, 200)
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, instance)).status, 200)
  } finally { runtime.close() }
})

test('storage delayed reads fence reset and disconnect while the other source stays available', async () => {
  const runtime = await fixture()
  const instance = 'storage-read-wait'
  const reset = () => runtime.request('/__preview/reset', instance, { scene: 'settings-storage-home-read-pending', pageId: 'settings-storage' })
  const get = (signal?: AbortSignal) => fetch(runtime.base + PREVIEW_STORAGE_READ.configPath, { headers: { 'x-preview-instance': instance }, signal })
  try {
    await reset()
    const arrived = once(runtime.server, 'request')
    const waiting = get()
    await arrived
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, instance)).status, 200)
    await reset()
    const cancelled = await waiting
    assert.equal(cancelled.status, 410)
    assert.deepEqual(await cancelled.json(), { detail: PREVIEW_STORAGE.disposed })
    const controller = new AbortController()
    const connection = once(runtime.server, 'request')
    const disconnected = get(controller.signal)
    const accepted = await connection
    const closed = once(accepted[1], 'close')
    const rejected = assert.rejects(disconnected, { name: 'AbortError' })
    controller.abort()
    await rejected
    await closed
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, instance)).status, 200)
    assert.equal((await get()).status, 200)
    assert.equal((await runtime.request(PREVIEW_STORAGE_READ.recoveryPath, instance, {})).status, 409)
  } finally { runtime.close() }
})

test('streamed answer events are cumulative snapshots consumed by the original renderer projection', async () => {
  const runtime = await fixture()
  const instance = 'stream-snapshot'
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'streaming' })
    const session = 'preview-session'
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '累计流快照' }] })
    await waitPreviewSession(runtime, instance, session, 'completed')
    const history = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    const deltas = history.activity_events.filter((event: ProductEvent) => event.type === 'message_delta') as Extract<ProductEvent, { type: 'message_delta' }>[]
    assert.equal(deltas.length, PREVIEW_CONVERSATION.normalChunks.length)
    let expected = ''
    let projected: ConvItem[] = []
    for (const [index, event] of deltas.entries()) {
      expected += PREVIEW_CONVERSATION.normalChunks[index]
      assert.equal(event.data.delta, expected)
      projected = projectStreamDelta(projected, 'agent', event.data.delta, event.turn_id, event.item_id, true, event.seq)
      assert.equal(projected.find(item => item.kind === 'agent')?.text, expected)
    }
    assert.equal(history.turns.find((turn: { role?: string }) => turn.role === 'assistant').text, expected)
  } finally { runtime.close() }
})

test('published output HTTP routes retain immutable VFS bytes and strict session and instance identities', async () => {
  const runtime = await fixture()
  const instance = 'published-outputs'
  try {
    const setup = await runtime.request(`/__preview/state?previewInstance=${instance}&page=viewer-outputs&scene=outputs-published`)
    assert.equal(setup.status, 200)
    const sessions = (await runtime.request(`/api/serve/sessions?scope=project&project_path=${encodeURIComponent(setup.body.projects[0].root)}`, instance)).body.sessions
    assert.equal(sessions.length, PREVIEW_ARTIFACTS.sampleSessions)
    const first = sessions[0].session_id
    const history = (await runtime.request(`/api/serve/history/${first}`, instance)).body
    assert.equal(history.artifacts.length, PREVIEW_ARTIFACTS.sample.length)
    const artifact = history.artifacts.find((entry: { path: string }) => entry.path === 'readme.md')
    assert.ok(artifact.publication_id)
    const endpoint = `/api/serve/sessions/${first}/artifacts/${artifact.artifact_id}/raw`
    const read = await fetch(runtime.base + endpoint, { headers: { 'x-preview-instance': instance } })
    assert.equal(read.status, 200)
    const bytes = new Uint8Array(await read.arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
    assert.equal(bytes.length, artifact.size)
    assert.equal(read.headers.get('etag'), `"sha256:${artifact.sha256}"`)
    assert.equal(read.headers.get('x-scholarseed-artifact-editable'), 'false')
    const head = await fetch(runtime.base + endpoint, { method: 'HEAD', headers: { 'x-preview-instance': instance } })
    assert.equal(head.status, 200)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal(head.headers.get('content-length'), String(bytes.length))
    assert.equal((await runtime.request(`/api/serve/sessions/${sessions[1].session_id}/artifacts/${artifact.artifact_id}/content`, instance)).status, 404)
    await runtime.request('/__preview/state?page=viewer-outputs&scene=outputs-published', 'other-publications')
    assert.equal((await runtime.request(endpoint, 'other-publications')).status, 404)
    const document = await runtime.request('/api/resource/write?project=preview-project', instance, { path: 'readme.md', content: '# Changed source after publication' })
    assert.equal(document.status, 200)
    const immutable = await fetch(runtime.base + endpoint, { headers: { 'x-preview-instance': instance } })
    assert.deepEqual(new Uint8Array(await immutable.arrayBuffer()), bytes)
    const restored = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: first })).body
    assert.deepEqual(restored.artifacts, history.artifacts)
    await runtime.request('/__preview/reset', instance, { pageId: 'viewer-outputs', scene: 'outputs-published' })
    assert.equal((await runtime.request(endpoint, instance)).status, 404)
  } finally { runtime.close() }
})

test('successful simulated turns publish one consistent artifact snapshot but cancelled or missing-source turns do not', async () => {
  const runtime = await fixture()
  const instance = 'artifact-delivery'
  const session = 'preview-session'
  try {
    await runtime.request('/__preview/state?page=viewer-outputs&scene=outputs-delivery', instance)
    assert.deepEqual((await runtime.request(`/api/serve/history/${session}`, instance)).body.artifacts, [])
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '取消模拟交付' }] })
    await runtime.request(`/api/serve/sessions/${session}/interrupt`, instance, {})
    const interrupted = await waitPreviewSession(runtime, instance, session, 'interrupted')
    assert.deepEqual(interrupted.artifacts, [])
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '完成模拟交付' }] })
    const completed = await waitPreviewSession(runtime, instance, session, 'completed', PREVIEW_CONVERSATION.interruptibleChunks.length * PREVIEW_CONVERSATION.interruptibleIntervalMs + CONVERSATION_STATE_TIMEOUT_MS)
    assert.equal(completed.artifacts.length, PREVIEW_ARTIFACTS.sample.length)
    const history = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.deepEqual(completed.artifacts, history.artifacts)
    const publications = history.activity_events.filter((event: { type: string }) => event.type === 'artifact_changed')
    assert.ok(publications.every((event: { data: { op: string } }) => event.data.op === 'upsert'))
    assert.deepEqual(publications.map((event: { data: { artifact: unknown } }) => event.data.artifact), history.artifacts)
    const terminal = history.activity_events.find((event: { type: string; turn_id: string }) => event.type === 'turn_completed' && event.turn_id === completed.last_turn_id)
    assert.ok(terminal)
    assert.ok(publications.every((event: { seq: number }) => event.seq < terminal.seq))
    const renamed = await runtime.request('/api/resource/node?project=preview-project', instance, { action: 'rename', path: 'hello.py', name: 'renamed.py' })
    assert.equal(renamed.status, 200)
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '源文件缺失不得伪成功' }] })
    const failed = await waitPreviewSession(runtime, instance, session, 'failed', PREVIEW_CONVERSATION.interruptibleChunks.length * PREVIEW_CONVERSATION.interruptibleIntervalMs + CONVERSATION_STATE_TIMEOUT_MS)
    assert.deepEqual(failed.artifacts, completed.artifacts)
    const after = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.equal(after.activity_events.filter((event: { type: string }) => event.type === 'artifact_changed').length, publications.length)
    assert.ok(after.activity_events.some((event: { type: string; data: { code?: string } }) => event.type === 'artifact_failed' && event.data.code === PREVIEW_ARTIFACTS.publishFailed))
    assert.equal(after.activity_events.some((event: { type: string; turn_id: string }) => event.type === 'turn_completed' && event.turn_id === failed.last_turn_id), false)
  } finally { runtime.close() }
})

test('artifact read policies remain persistent until explicit per-instance recovery without changing publications', async () => {
  const runtime = await fixture()
  try {
    for (const policy of ['catalog', 'history', 'content']) {
      const instance = `artifact-${policy}-failed`
      const setup = await runtime.request(`/__preview/state?page=viewer-outputs&scene=outputs-${policy}-failed`, instance)
      assert.equal(setup.status, 200)
      const artifact = setup.body.sessions[0].artifacts[0]
      assert.equal((await runtime.request('/api/serve/history/not-a-session', instance)).status, 404)
      const endpoint = policy === 'catalog' ? '/api/serve/sessions?scope=project&project_path=%2Fpreview%2Fworkspace%2Fdesign'
        : policy === 'history' ? '/api/serve/history/preview-session'
          : `/api/serve/sessions/preview-session/artifacts/${artifact.artifact_id}/content`
      for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await runtime.request(endpoint, instance)).status, 503)
      const before = setup.body.sessions[0].artifacts
      for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await runtime.request(PREVIEW_ARTIFACTS.recoveryPath, instance, {})).status, 200)
      assert.equal((await runtime.request(endpoint, instance)).status, 200)
      const after = (await runtime.request('/api/serve/history/preview-session', instance)).body
      assert.deepEqual(after.artifacts, before)
      await runtime.request('/__preview/reset', instance, { pageId: 'viewer-outputs', scene: `outputs-${policy}-failed` })
      const reset = (await runtime.request('/__preview/state', instance)).body
      const currentEndpoint = policy === 'content' ? `/api/serve/sessions/preview-session/artifacts/${reset.sessions[0].artifacts[0].artifact_id}/content` : endpoint
      assert.equal((await runtime.request(currentEndpoint, instance)).status, 503)
    }
    assert.equal((await runtime.request(PREVIEW_ARTIFACTS.recoveryPath, 'first', {})).status, 409)
  } finally { runtime.close() }
})

test('deleting a session fences delayed artifact content and history replies', async () => {
  const runtime = await fixture()
  try {
    for (const kind of ['content', 'history']) {
      const instance = `removed-artifact-${kind}`
      const setup = await runtime.request(`/__preview/state?page=viewer-outputs&scene=outputs-${kind}-pending`, instance)
      const session = setup.body.sessions[0].session_id
      const artifact = setup.body.sessions[0].artifacts[0]
      const endpoint = kind === 'content' ? `/api/serve/sessions/${session}/artifacts/${artifact.artifact_id}/raw` : `/api/serve/history/${session}`
      const admitted = once(runtime.server, 'request')
      const flight = fetch(runtime.base + endpoint, { headers: { 'x-preview-instance': instance } }).then(async response => { await response.arrayBuffer(); return response.status })
      await admitted
      const removed = await fetch(`${runtime.base}/api/serve/sessions/${session}`, { method: 'DELETE', headers: { 'x-preview-instance': instance } })
      assert.equal(removed.status, 200)
      assert.equal(await flight, 404)
    }
  } finally { runtime.close() }
})

test('output faults leave global startup catalog readable and new-session context retains declared search metadata without execution', async () => {
  const runtime = await fixture()
  const instance = 'output-scope-context'
  try {
    await runtime.request('/__preview/state?page=viewer-outputs&scene=outputs-catalog-failed', instance)
    assert.equal((await runtime.request('/api/serve/sessions?scope=all', instance)).status, 200)
    assert.equal((await runtime.request('/api/serve/sessions?scope=project&project_path=%2Fpreview%2Fworkspace%2Fdesign', instance)).status, 503)
    const created = await runtime.request('/api/serve/sessions/open', instance, { project_path: '/preview/workspace/design' })
    const endpoint = `/api/assistant/sessions/${created.body.session_id}/context`
    const original = (await runtime.request(endpoint, instance)).body
    const response = await fetch(runtime.base + endpoint, {
      method: 'PATCH', headers: { 'x-preview-instance': instance, 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: original.revision, project_policy: 'explicit_only', search_scope: 'web', refs: [] }),
    })
    assert.equal(response.status, 200)
    const selection = await response.json()
    assert.equal(selection.search_scope, 'web')
    assert.equal(selection.project_policy, 'explicit_only')
    assert.equal(selection.revision, original.revision + 1)
    assert.equal((await runtime.request('/api/healthz', instance)).body.capabilities.web_search, false)
  } finally { runtime.close() }
})
const CONVERSATION_STREAM_CLOSE_TIMEOUT_MS = 1_000

test('browser command admitted before reset cannot commit after its partial body completes', async () => {
  const runtime = await fixture()
  const instance = 'partial-browser-reset'
  const body = JSON.stringify({ kind: 'open' })
  await runtime.request(`/__preview/state?previewInstance=${instance}&page=page-browser&scene=browser-blank`)
  const pending = httpRequest(`${runtime.base}${PREVIEW_BROWSER.path}/command?previewInstance=${instance}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  })
  const response = once(pending, 'response')
  try {
    const admitted = once(runtime.server, 'request')
    pending.write(body.slice(0, -1))
    await admitted
    assert.equal((await runtime.request('/__preview/reset', instance, { scene: 'browser-blank', pageId: 'page-browser' })).status, 200)
    pending.end(body.slice(-1))
    const [received] = await response
    let payload = ''
    for await (const chunk of received) payload += chunk.toString()
    assert.equal(received.statusCode, 409)
    assert.deepEqual(JSON.parse(payload), { detail: 'preview_instance_reset' })
    const current = await runtime.request(`${PREVIEW_BROWSER.path}/snapshot`, instance, {})
    assert.equal(current.body.ok, true)
    assert.deepEqual(current.body.snapshot.tabs, [])
    assert.equal(current.body.snapshot.activeTabId, null)
  } finally { pending.destroy(); runtime.close() }
})

test('browser surface HTTP bridge shares blank tab identity while native actions and stale generations stay rejected', async () => {
  const runtime = await fixture()
  const instance = 'browser-surface-http'
  try {
    const setup = await runtime.request(`/__preview/state?previewInstance=${instance}&page=page-browser&scene=browser-tabs`)
    assert.equal(setup.status, 200)
    const bridge = createPreviewBridge({
      instance, scene: 'browser-tabs', pageId: 'page-browser', preferences: setup.body.preferences,
      simulation: { browser: { seed: 'empty', surface: { seed: 'sample' } } }, request: (input, init) => fetch(new URL(String(input), runtime.base), init),
    })
    const initial = await bridge.browser.snapshot()
    assert.ok(initial.ok)
    assert.equal(initial.snapshot.tabs.length, PREVIEW_BROWSER.surfaceSampleCount)
    assert.equal(bridge.browserEnabled, false)
    assert.equal(initial.snapshot.engine, undefined)
    const originalId = initial.snapshot.tabs[0].tabId
    const selected = await bridge.browser.dispatch({ kind: 'select', tabId: initial.snapshot.tabs[1].tabId })
    assert.ok(selected.ok)
    assert.equal(selected.snapshot.activeTabId, initial.snapshot.tabs[1].tabId)
    const opened = await bridge.browser.dispatch({ kind: 'open', input: PREVIEW_BROWSER.blankPage })
    assert.ok(opened.ok)
    assert.equal(opened.snapshot.tabs.length, PREVIEW_BROWSER.surfaceSampleCount + 1)
    for (const command of [{ kind: 'navigate', tabId: originalId, input: 'https://example.org' }, { kind: 'copy-endpoint' }, { kind: 'reload', tabId: originalId }] as const) assert.deepEqual(await bridge.browser.dispatch(command), { ok: false, error: 'permission_denied' })
    assert.deepEqual(await bridge.browser.snapshot(), opened)
    const history = await bridge.browser.history({ kind: 'query', query: { offset: 0, limit: 20 } })
    assert.deepEqual(history, { ok: true, page: { items: [], total: 0 } })
    const policy = await bridge.browser.policy({ kind: 'read' })
    assert.ok(policy.ok)
    assert.equal(policy.policy.revision, 0)
    assert.equal(policy.policy.agentBrowserUseEnabled, false)
    const foreign = 'browser-surface-foreign'
    await runtime.request(`/__preview/state?previewInstance=${foreign}&page=viewer-browser&scene=viewer-browser-tabs`, foreign)
    assert.deepEqual((await runtime.request(`${PREVIEW_BROWSER.path}/command`, foreign, { kind: 'close', tabId: originalId })).body, { ok: false, error: 'target_closed' })
    assert.deepEqual((await runtime.request(`${PREVIEW_BROWSER.path}/snapshot`, instance, { extra: true })).body, { ok: false, error: 'invalid_command' })
    assert.deepEqual((await runtime.request(`${PREVIEW_BROWSER.path}/snapshot`, instance, [])).body, { ok: false, error: 'invalid_command' })
    assert.equal((await runtime.request(`${PREVIEW_BROWSER.path}/snapshot`, instance)).status, 501)
    await runtime.request('/__preview/reset', instance, { scene: 'browser-tabs', pageId: 'page-browser' })
    assert.deepEqual(await bridge.browser.dispatch({ kind: 'select', tabId: originalId }), { ok: false, error: 'target_closed' })
    const reset = await bridge.browser.snapshot()
    assert.ok(reset.ok)
    assert.equal(reset.snapshot.tabs.length, PREVIEW_BROWSER.surfaceSampleCount)
    assert.ok(reset.snapshot.tabs.every(tab => tab.tabId !== originalId && tab.url === PREVIEW_BROWSER.blankPage))
  } finally { runtime.close() }
})

test('browser history reset disposes a real in-flight deletion and cannot delete the replacement generation', async () => {
  const runtime = await fixture()
  const instance = 'browser-reset-pending'
  const path = `${PREVIEW_BROWSER.path}/history`
  try {
    await runtime.request(`/__preview/state?previewInstance=${instance}&page=settings-browser&scene=settings-browser-write-pending`)
    const query = { kind: 'query', query: { offset: 0, limit: 20 } }
    const before = await runtime.request(path, instance, query)
    const id = before.body.page.items[0].id
    const deletion = runtime.request(path, instance, { kind: 'delete', id })
    const deadline = Date.now() + CONVERSATION_STATE_TIMEOUT_MS
    let clearing = false
    while (Date.now() < deadline) {
      const observation = await runtime.request(path, instance, query)
      if (observation.body.error === 'cdp_busy') { clearing = true; break }
    }
    assert.equal(clearing, true)
    await runtime.request('/__preview/reset', instance, { scene: 'settings-browser-write-pending', pageId: 'settings-browser' })
    assert.equal((await deletion).status, 410)
    const current = await runtime.request(path, instance, query)
    assert.equal(current.body.page.total, PREVIEW_BROWSER.sampleCount)
    assert.ok(current.body.page.items.every((visit: { id: string }) => visit.id !== id))
  } finally { runtime.close() }
})

test('browser settings bridge uses HTTP instance ledgers, validates requests and resets without native authority', async () => {
  const runtime = await fixture()
  const instance = 'browser-http'
  try {
    const setup = await runtime.request(`/__preview/state?previewInstance=${instance}&page=settings-browser&scene=settings-browser-states`)
    assert.equal(setup.status, 200)
    const bridge = createPreviewBridge({
      instance, scene: 'settings-browser-states', pageId: 'settings-browser', preferences: setup.body.preferences,
      simulation: { browser: { seed: 'sample' } }, request: (input, init) => fetch(new URL(String(input), runtime.base), init),
    })
    assert.equal(bridge.browserEnabled, false)
    const initial = await bridge.browser.history({ kind: 'query', query: { offset: 0, limit: 20 } })
    assert.ok(initial.ok && initial.page)
    assert.equal(initial.page.total, PREVIEW_BROWSER.sampleCount)
    const firstId = initial.page.items[0].id
    assert.deepEqual(await bridge.browser.history({ kind: 'delete', id: firstId }), { ok: true, deleted: true })
    await bridge.browser.policy({ kind: 'set-agent-use', enabled: true })
    const untouched = await runtime.request(`${PREVIEW_BROWSER.path}/policy`, 'browser-other', { kind: 'read' })
    assert.equal(untouched.status, 501)
    const bad = await runtime.request(`${PREVIEW_BROWSER.path}/policy`, instance, { kind: 'set', origin: 'file:///private', action: 'read', decision: 'allow' })
    assert.equal(bad.status, 200)
    assert.deepEqual(bad.body, { ok: false, error: 'invalid_command' })
    assert.equal((await runtime.request(`${PREVIEW_BROWSER.path}/policy`, instance)).status, 501)
    const reset = await runtime.request('/__preview/reset', instance, { scene: 'settings-browser-states', pageId: 'settings-browser' })
    assert.equal(reset.status, 200)
    const history = await bridge.browser.history({ kind: 'query', query: { offset: 0, limit: 20 } })
    assert.ok(history.ok && history.page)
    assert.equal(history.page.total, PREVIEW_BROWSER.sampleCount)
    assert.deepEqual(await bridge.browser.history({ kind: 'delete', id: firstId }), { ok: true, deleted: false })
    const policy = await bridge.browser.policy({ kind: 'read' })
    assert.ok(policy.ok)
    assert.equal(policy.policy.agentBrowserUseEnabled, false)
    assert.deepEqual(await bridge.browser.history({ kind: 'reopen', id: firstId }), { ok: false, error: 'desktop_bridge_unavailable' })
    assert.equal((await runtime.request(PREVIEW_BROWSER.recoveryPath, instance, {})).status, 409)
    await runtime.request('/__preview/reset', instance, { scene: 'settings-browser-retry', pageId: 'settings-browser' })
    assert.deepEqual(await bridge.browser.policy({ kind: 'read' }), { ok: false, error: 'browser_policy_io_unavailable' })
    assert.equal((await runtime.request(PREVIEW_BROWSER.recoveryPath, instance)).status, 501)
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await runtime.request(PREVIEW_BROWSER.recoveryPath, instance, {})).status, 200)
    const recovered = await bridge.browser.policy({ kind: 'read' })
    assert.ok(recovered.ok)
    assert.equal(recovered.policy.revision, 0)
    await runtime.request('/__preview/reset', instance, { scene: 'settings-browser-retry', pageId: 'settings-browser' })
    assert.deepEqual(await bridge.browser.policy({ kind: 'read' }), { ok: false, error: 'browser_policy_io_unavailable' })
  } finally { runtime.close() }
})

test('literature library shares nonempty rows, filters, detail edits and notes through the original client', async () => {
  const runtime = await fixture()
  const instance = 'literature-client'
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const queryBase = `${runtime.base}/?previewInstance=${instance}`
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: queryBase }, scholarseed: { getApiBase: () => runtime.base } } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input))
    url.searchParams.set('previewInstance', instance)
    return originalFetch(url, init)
  }
  try {
    assert.equal((await runtime.request('/__preview/reset', instance, { scene: 'library-populated', pageId: 'page-literature' })).status, 200)
    const rows = await listAllLiteratures({})
    assert.equal(rows.length, 3)
    assert.equal((await getLiteratureCounts()).all, rows.length)
    const target = rows.find(row => row.primary_attachment?.availability === 'available')!
    assert.ok(target)
    const attachment = target.primary_attachment!
    const source = { kind: 'literature' as const, literatureId: target.id, attachmentId: attachment.id, recordTarget: attachment.record_target, path: attachment.name, mediaType: attachment.media_type }
    const loaded = await loadDocument(source)
    if ('kind' in loaded) assert.fail(JSON.stringify(loaded))
    assert.equal(loaded.viewer, 'pdf')
    assert.equal(loaded.capabilities.can_annotate, false)
    assert.equal(createHash('sha256').update(loaded.bytes).digest('hex'), PREVIEW_DOCUMENTS.find(document => document.path === 'sample.pdf')!.sha256)
    const attachmentPath = `/api/v1/literatures/${target.id}/attachments/${attachment.id}`
    const contentUrl = `${runtime.base}${attachmentPath}/content?previewInstance=${instance}`
    const partial = await originalFetch(contentUrl, { headers: { range: 'bytes=0-4' } })
    assert.equal(partial.status, 206)
    assert.equal(await partial.text(), '%PDF-')
    assert.equal(partial.headers.get('etag'), `"${loaded.revision}"`)
    const head = await originalFetch(contentUrl, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), loaded.bytes.length)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const invalidRange = await originalFetch(contentUrl, { headers: { range: 'bytes=999999999-' } })
    assert.equal(invalidRange.status, 416)
    const records = (await runtime.request(`${attachmentPath}/records`, instance)).body
    assert.deepEqual(records.record_target, { owner: 'literature_attachment', scope_id: target.id, subject_id: attachment.id })
    assert.equal(records.source_revision, loaded.revision)
    assert.deepEqual(records.records.marks, [])
    const regions = await runtime.request(`${attachmentPath}/regions?revision=${encodeURIComponent(loaded.revision)}&start_page=1&end_page=1`, instance)
    assert.equal(regions.status, 200)
    assert.deepEqual(regions.body.unavailable_pages, [1])
    assert.deepEqual((await runtime.request(`/api/literature/${target.id}/ai/results?source_revision=${encodeURIComponent(loaded.revision)}`, instance)).body, {})
    assert.equal((await runtime.request(`/api/literature/${target.id}/ai/results`, instance)).status, 422)
    assert.equal((await runtime.request(`${attachmentPath}/location`, instance)).status, 501)
    const missing = rows.find(row => row.primary_attachment?.availability === 'missing')!
    assert.equal((await runtime.request(`/api/v1/literatures/${missing.id}/attachments/${missing.primary_attachment!.id}/open`, instance)).status, 404)
    assert.equal((await runtime.request(`/api/v1/literatures/${missing.id}/attachments/${attachment.id}/open`, instance)).status, 404)
    assert.deepEqual((await listAllLiteratures({ q: target.title })).map(row => row.id), [target.id])
    const tag = target.tags[0]
    assert.ok(tag)
    assert.ok((await getLiteratureTagFacets({})).tags.some(candidate => candidate.id === tag.id && candidate.total > 0))
    const updated = await updateLiterature(target.id, { fields: { title: '模拟修改后的目录标题' } })
    assert.equal(updated.title, '模拟修改后的目录标题')
    assert.equal((await getLiterature(target.id)).title, updated.title)
    assert.deepEqual((await listAllLiteratures({ q: updated.title })).map(row => row.id), [target.id])
    const note = await addLiteratureNote(target.id, '模拟本地笔记', '模拟笔记标题')
    const changed = await updateLiteratureNote(target.id, note.id, { title: note.title, text: '模拟已编辑笔记', version: note.version })
    assert.equal(changed.text, '模拟已编辑笔记')
    assert.ok((await listLiteratureNotes(target.id)).some(candidate => candidate.id === changed.id && candidate.text === changed.text))
    await deleteLiteratureNote(target.id, note.id)
    assert.equal((await listLiteratureNotes(target.id)).some(candidate => candidate.id === note.id), false)
    await runtime.request('/__preview/reset', instance, { scene: 'literature-browse', pageId: 'page-literature' })
    assert.deepEqual(await listAllLiteratures({}), [])
  } finally {
    globalThis.fetch = originalFetch
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    runtime.close()
  }
})

test('reset rejects an admitted partial turn body before it can restart a disposed session', async () => {
  const runtime = await fixture()
  const instance = 'partial-turn-reset'
  const body = JSON.stringify({ input: [{ type: 'text', text: 'stale body' }] })
  const pending = httpRequest(`${runtime.base}/api/serve/sessions/preview-session/turns?previewInstance=${instance}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  })
  const response = once(pending, 'response')
  try {
    const admitted = once(runtime.server, 'request')
    pending.write(body.slice(0, -1))
    await admitted
    assert.equal((await runtime.request('/__preview/reset', instance, { scene: 'chat' })).status, 200)
    pending.end(body.slice(-1))
    const [received] = await response
    let payload = ''
    for await (const chunk of received) payload += chunk.toString()
    assert.equal(received.statusCode, 409)
    assert.deepEqual(JSON.parse(payload), { detail: 'preview_instance_reset' })
    const history = (await runtime.request('/api/serve/history/preview-session', instance)).body
    assert.deepEqual(history.turns, [])
    assert.deepEqual(history.activity_events, [])
  } finally { pending.destroy(); runtime.close() }
})

test('interruptible conversation preserves its prefix after real interrupt and all remaining scheduled slots', async () => {
  const runtime = await fixture()
  const instance = 'stream-cancel'
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-cancel', pageId: 'page-conversation' })
    const session = 'preview-session'
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '取消长流' }], client_user_message_id: 'cancel-prefix' })
    const started = performance.now()
    let history
    do {
      history = (await runtime.request(`/api/serve/history/${session}`, instance)).body
      if (history.turns.some((turn: { role?: string }) => turn.role === 'assistant')) break
      assert.ok(performance.now() - started < CONVERSATION_STATE_TIMEOUT_MS)
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() - started < CONVERSATION_STATE_TIMEOUT_MS)
    assert.ok(history.turns.some((turn: { role?: string }) => turn.role === 'assistant'), 'Expected a streamed answer prefix')
    const before = history.turns.find((turn: { role?: string }) => turn.role === 'assistant').text
    assert.ok(before.startsWith(PREVIEW_CONVERSATION.interruptibleChunks[0]))
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/interrupt`, instance, {})).status, 200)
    const interrupted = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
    assert.equal(interrupted.running, false)
    assert.equal(interrupted.last_turn_status, 'interrupted')
    const terminalHistory = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    await new Promise(resolve => setTimeout(resolve, PREVIEW_CONVERSATION.interruptibleChunks.length * PREVIEW_CONVERSATION.interruptibleIntervalMs))
    const stable = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.deepEqual(stable, terminalHistory)
    assert.equal(stable.turns.find((turn: { role?: string }) => turn.role === 'assistant').text, before)
    assert.equal(stable.activity_events.some((event: { type: string }) => event.type === 'turn_completed'), false)
    assert.equal((await runtime.request(`/api/serve/sessions/${session}/queue/cancel-prefix/reconcile`, instance, {})).body.outcome, 'applied')
  } finally { runtime.close() }
})

test('conversation fault closes the actual SSE once while domain history completes and cursor replay resumes', async () => {
  const runtime = await fixture()
  const instance = 'stream-reconnect'
  try {
    const { session, frames } = await faultPreviewSession(runtime, instance)
    assert.ok(frames.some(event => event.type === 'message_delta'))
    assert.equal(frames.some(event => event.type === 'turn_completed'), false)
    const cursor = frames.at(-1).seq
    const admitted = once(runtime.server, 'request')
    let headersReady = false
    const reopening = fetch(`${runtime.base}/api/serve/sessions/${session}/events?from_seq=${cursor}&previewInstance=${instance}`).then(response => { headersReady = true; return response })
    await admitted
    const completed = await waitPreviewSession(runtime, instance, session, 'completed')
    assert.equal(headersReady, false, 'domain progress must not wait for the delayed reconnect handshake')
    assert.ok(completed.last_seq > cursor)
    const reopened = await reopening
    assert.equal(reopened.status, 200)
    const reader = reopened.body!.getReader()
    const replay = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    const resumed = replay.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice('data: '.length)))
    assert.ok(resumed.every(event => event.seq > cursor))
    assert.deepEqual(resumed.map(event => event.seq), Array.from({ length: completed.last_seq - cursor }, (_, index) => cursor + index + 1))
    assert.equal(resumed.filter(event => event.type === 'turn_completed').length, 1)
    const history = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.equal(history.turns.filter((turn: { role?: string }) => turn.role === 'assistant').length, 1)
    assert.equal(history.turns.find((turn: { role?: string }) => turn.role === 'assistant').text, PREVIEW_CONVERSATION.answer)
  } finally { runtime.close() }
})

test('reset cancels an admitted conversation reconnect handshake without replaying old session data', async () => {
  const runtime = await fixture()
  const instance = 'stream-reset'
  try {
    const { session, frames } = await faultPreviewSession(runtime, instance)
    const admitted = once(runtime.server, 'request')
    const reopening = fetch(`${runtime.base}/api/serve/sessions/${session}/events?from_seq=${frames.at(-1).seq}&previewInstance=${instance}`)
    await admitted
    assert.equal((await runtime.request('/__preview/reset', instance, { scene: 'conversation-stream', pageId: 'page-conversation' })).status, 200)
    const cancelled = await reopening
    assert.equal(cancelled.status, 410)
    assert.deepEqual(await cancelled.json(), { code: 'preview_transport_disposed' })
    const current = (await runtime.request(`/api/serve/history/${session}`, instance)).body
    assert.deepEqual(current.turns, [])
    assert.deepEqual(current.activity_events, [])
  } finally { runtime.close() }
})

test('developer real account clients use only instance-owned simulated keys and never issue usable credentials', async () => {
  const runtime = await fixture()
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const previousBase = accountBase()
  const instance = 'developer-client'
  globalThis.fetch = (input, init) => {
    assert.ok(String(input).startsWith(runtime.base + '/'))
    return previousFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': instance } })
  }
  try {
    const reset = await runtime.request('/__preview/reset', instance, { scene: 'settings-developer-states', pageId: 'settings-developer' })
    assert.equal(reset.status, 200)
    const state = await readPreviewAccountState(Response.json(reset.body), instance, 'ready')
    const bridge = createPreviewBridge({ instance, scene: 'settings-developer-states', preferences: state.preferences, account: state.account, simulation: { account: 'ready' }, request: globalThis.fetch })
    globalThis.window = { scholarseed: { ...bridge, getApiBase: () => runtime.base }, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, dispatchEvent: () => true } as unknown as Window & typeof globalThis
    setAccountBase(previewAccountBase(runtime.base, state.account))
    assert.deepEqual((await runtime.request('/api/serve/skill-credential', instance, {})).body, { ok: true, ready: false })
    assert.deepEqual(await runtime.request('/api/serve/skill-credential', instance, { token: 'must-not-echo' }), { status: 422, body: { code: 'preview_developer_invalid' } })
    const first = await listApiKeys()
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('Missing simulated developer list')
    assert.equal(first.data.keys.length, 2)
    assert.equal(JSON.stringify(first.data).includes('token'), false)
    const managed = first.data.keys.find(key => key.managed)!
    await runtime.request('/api/serve/skill-credential', instance, {})
    assert.deepEqual(await listApiKeys(), first)
    const created = await createApiKey('模拟临时工具')
    assert.equal(created.ok, true)
    if (!created.ok) throw new Error('Missing simulated created key')
    assert.ok(created.data.token.startsWith('preview-only:'))
    assert.equal(JSON.stringify((await runtime.request('/__preview/state', instance)).body).includes(created.data.token), false)
    const listed = await listApiKeys()
    assert.equal(listed.ok, true)
    assert.equal(JSON.stringify(listed).includes(created.data.token), false)
    assert.equal((await revokeApiKey(managed.key_id)).ok, false)
    assert.equal((await rotateApiKey(created.data.key_id)).ok, false)
    assert.deepEqual(await revokeApiKey(created.data.key_id), { ok: true, data: { revoked: true } })
    assert.deepEqual(await rotateApiKey(managed.key_id), { ok: true, data: { rotated: true } })
    assert.deepEqual((await runtime.request('/api/serve/skill-credential/refresh', instance, {})).body, { ok: true, issued: false, aligned: 0 })
    const rotated = await listApiKeys()
    assert.equal(rotated.ok, true)
    if (rotated.ok) assert.notEqual(rotated.data.keys.find(key => key.managed)?.key_id, managed.key_id)
    const unauthorized = await previousFetch(runtime.base + '/api/account/api-keys', { headers: { 'x-preview-instance': instance, authorization: 'Bearer real-or-foreign-token' } })
    assert.equal(unauthorized.status, 401)
    const foreignReset = await previousFetch(runtime.base + '/__preview/reset', { method: 'POST', headers: { 'x-preview-instance': 'developer-other', 'content-type': 'application/json' }, body: JSON.stringify({ scene: 'settings-developer-states', pageId: 'settings-developer' }) })
    assert.equal(foreignReset.status, 200)
    const foreign = await foreignReset.json()
    const crossInstance = await previousFetch(runtime.base + '/api/account/api-keys', { headers: { 'x-preview-instance': 'developer-other', authorization: `Bearer ${state.account!.capability}` } })
    assert.equal(crossInstance.status, 401)
    assert.notEqual(foreign.account.capability, state.account!.capability)
    const foreignList = await previousFetch(runtime.base + '/api/account/api-keys', { headers: { 'x-preview-instance': 'developer-other', authorization: `Bearer ${foreign.account.capability}` } })
    const foreignKeys = await foreignList.json()
    assert.equal(foreignList.status, 200)
    const foreignOperation = await revokeApiKey(foreignKeys.keys[0].key_id)
    assert.equal(foreignOperation.ok, false)
    if (!foreignOperation.ok) assert.equal(foreignOperation.code, 'preview_developer_key_not_found')
    await runtime.request('/__preview/reset', instance, { scene: 'settings-developer-states', pageId: 'settings-developer' })
    const expired = await previousFetch(runtime.base + '/api/account/api-keys', { headers: { 'x-preview-instance': instance, authorization: `Bearer ${state.account!.capability}` } })
    assert.equal(expired.status, 401)
  } finally {
    setAccountBase(previousBase)
    globalThis.fetch = previousFetch
    globalThis.window = previousWindow
    runtime.close()
  }
})

test('developer reset fences an admitted delayed list and never exposes the old namespace', async () => {
  const runtime = await fixture()
  try {
    const initial = await runtime.request('/__preview/reset', 'developer-delayed', { scene: 'settings-developer-pending', pageId: 'settings-developer' })
    const admitted = once(runtime.server, 'request')
    const reading = fetch(runtime.base + '/api/account/api-keys', { headers: { 'x-preview-instance': 'developer-delayed', authorization: `Bearer ${initial.body.account.capability}` } })
    await admitted
    const reset = await runtime.request('/__preview/reset', 'developer-delayed', { scene: 'settings-developer-empty', pageId: 'settings-developer' })
    assert.equal(reset.status, 200)
    const cancelled = await reading
    assert.equal(cancelled.status, 410)
    assert.deepEqual(await cancelled.json(), { code: 'preview_developer_disposed' })
    const fresh = await fetch(runtime.base + '/api/account/api-keys', { headers: { 'x-preview-instance': 'developer-delayed', authorization: `Bearer ${reset.body.account.capability}` } })
    assert.deepEqual(await fresh.json(), { keys: [] })
  } finally { runtime.close() }
})

test('archive real project clients restore and forget through an accepted operation without deleting files', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  try {
    await runtime.request('/__preview/reset', 'default', { scene: 'settings-archives-states', pageId: 'settings-archives' })
    const listing = await listProjects(true)
    const archived = listing?.projects.filter(project => project.archived_at != null) ?? []
    assert.equal(archived.length, 2, 'archive scene must seed real archived projects, not an empty placeholder')
    assert.equal((await listProjects())?.projects.length, 1)
    const restored = await setProjectArchived(archived[0].id, false)
    assert.equal(restored.ok, true)
    assert.equal(restored.project?.archived_at, null)
    assert.equal((await forgetProject(archived[1].id)).ok, true)
    assert.equal((await listProjects(true))?.projects.some(project => project.id === archived[1].id), false)
  } finally { globalThis.window = originalWindow; runtime.close() }
})

test('external root consumers authorize exactly registered writable project roots even when there are no external links', async () => {
  const runtime = await fixture()
  const previous = globalThis.window
  let synchronized: Promise<boolean> | undefined
  try {
    const state = (await runtime.request('/__preview/reset', 'default', { scene: 'page-home' })).body
    const project = state.projects[0]
    const bridge = createPreviewBridge({ instance: 'default', scene: 'page-home', preferences: state.preferences, storage: state.storage, request: (input, init) => fetch(new URL(String(input), runtime.base), init) })
    globalThis.window = { scholarseed: { ...bridge, getApiBase: () => runtime.base, syncAuthorizedRoots: (scope, roots) => { synchronized = bridge.syncAuthorizedRoots(scope, roots); return synchronized } } } as Window & typeof globalThis
    selectExternalRootProject(project.id)
    assert.deepEqual(await listExternalRoots(project.id), { roots: [], writableRoots: [project.root] })
    assert.equal((await runtime.request('/__preview/state', 'default')).body.diagnostics.roots.external, 1)
    for (const root of ['/preview/workspace', project.root + '/child', '/preview/unknown', '/Users/private']) assert.equal(await bridge.addAuthorizedRoot('external', root), false)
    const foreign = (await runtime.request('/__preview/reset', 'foreign', { scene: 'settings-archives-states', pageId: 'settings-archives' })).body
    const foreignProject = foreign.projects.find((entry: { root: string }) => entry.root !== project.root)
    assert.equal(await bridge.addAuthorizedRoot('external', foreignProject.root), false)
    assert.equal((await forgetProject(project.id)).ok, true)
    assert.equal(await bridge.addAuthorizedRoot('external', project.root), false)
    assert.equal((await runtime.request('/__preview/state', 'default')).body.diagnostics.roots.external, 0)
  } finally {
    if (globalThis.window !== previous) { selectExternalRootProject(null); await synchronized }
    globalThis.window = previous
    runtime.close()
  }
})

test('archive real task consumers expose completed history, restore and delete only their selected task', async () => {
  const runtime = await fixture()
  const previous = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  try {
    const seeded = (await runtime.request('/__preview/reset', 'default', { scene: 'settings-archives-states', pageId: 'settings-archives' })).body
    const bridge = createPreviewBridge({ instance: 'default', scene: 'settings-archives-states', preferences: seeded.preferences, storage: seeded.storage, request: (input, init) => fetch(new URL(String(input), runtime.base), init) })
    globalThis.window = { scholarseed: { ...bridge, getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
    const rows = await listAllSessions({ archived: true })
    assert.equal(rows?.length, 2)
    assert.ok(rows)
    assert.ok(seeded.projects.some((project: { root: string; archived_at?: number }) => project.root === rows[0].project_path && project.archived_at == null))
    const history = await getHistoryWithTodos(rows[0].session_id)
    assert.equal(history?.turns.length, 3)
    assert.deepEqual(history?.turns.map(turn => turn.kind), ['text', 'text', 'tool'])
    assert.equal((await setSessionArchived(rows[0].session_id, false)).ok, true)
    assert.equal((await listAllSessions({ archived: true }))?.length, 1)
    assert.deepEqual(await deleteSession(rows[1].session_id), { ok: true, status: 200 })
    assert.equal((await listAllSessions({ archived: true }))?.length, 0)
    assert.equal(await getHistoryWithTodos(rows[1].session_id), null)
    assert.equal((await runtime.request('/api/content/projects?includeArchived=true', 'default')).body.projects.length, 3)
  } finally { globalThis.window = previous; runtime.close() }
})

test('archive project consumers preserve partial batch results and resolve a failed accepted deletion before retry', async () => {
  const runtime = await fixture()
  const previous = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  const reset = () => runtime.request('/__preview/reset', 'default', { scene: 'settings-archives-write-failed', pageId: 'settings-archives' })
  try {
    const state = (await reset()).body
    const projects = state.projects.filter((project: { archived_at?: number }) => project.archived_at != null)
    assert.equal((await setProjectArchived('unknown-project', false)).ok, false)
    assert.deepEqual(await setProjectArchived(projects[0].id, false), { ok: false, error: PREVIEW_ARCHIVE.writeFailure, project: undefined })
    assert.equal((await setProjectArchived(projects[1].id, false)).ok, true)
    assert.equal((await listProjects(true))?.projects.filter(project => project.archived_at != null).length, 1)
    assert.equal((await setProjectArchived(projects[0].id, false)).ok, true)
    const fresh = (await reset()).body
    const project = fresh.projects.find((project: { archived_at?: number }) => project.archived_at != null)
    const file = await runtime.request(`/api/resource/read?project=${project.id}&path=readme.md`, 'default')
    assert.deepEqual(await forgetProject(project.id), { ok: false, error: PREVIEW_ARCHIVE.writeFailure })
    assert.deepEqual(await runtime.request(`/api/resource/read?project=${project.id}&path=readme.md`, 'default'), file)
    assert.equal((await forgetProject(project.id)).ok, true)
    assert.equal((await listProjects(true))?.projects.some(entry => entry.id === project.id), false)
  } finally { globalThis.window = previous; runtime.close() }
})

test('archive project recovery is explicit, instance-scoped and resettable without changing active catalogues', async () => {
  const runtime = await fixture()
  const reset = (instance: string, scene = 'settings-archives-required') => runtime.request('/__preview/reset', instance, { scene, pageId: 'settings-archives' })
  try {
    const original = (await reset('archive-project-recovery')).body
    await reset('archive-project-isolated')
    const projectsPath = '/api/content/projects?includeArchived=true'
    const failed = { status: 503, body: { detail: PREVIEW_ARCHIVE.projectReadFailure } }
    for (let attempt = 0; attempt < 2; attempt += 1) assert.deepEqual(await runtime.request(projectsPath, 'archive-project-recovery'), failed)
    assert.equal((await runtime.request('/api/content/projects', 'archive-project-recovery')).body.projects.length, 1)
    assert.equal((await runtime.request('/api/serve/sessions?archived=true', 'archive-project-recovery')).body.sessions.length, 2)
    assert.equal((await runtime.request(PREVIEW_ARCHIVE.recoveryPath, 'archive-project-recovery')).status, 501)
    for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await runtime.request(PREVIEW_ARCHIVE.recoveryPath, 'archive-project-recovery', {})).status, 200)
    assert.deepEqual((await runtime.request(projectsPath, 'archive-project-recovery')).body.projects, original.projects)
    assert.deepEqual(await runtime.request(projectsPath, 'archive-project-isolated'), failed)
    await reset('archive-project-recovery')
    assert.deepEqual(await runtime.request(projectsPath, 'archive-project-recovery'), failed)
    await reset('archive-project-recovery', 'settings-archives-states')
    assert.equal((await runtime.request(PREVIEW_ARCHIVE.recoveryPath, 'archive-project-recovery', {})).status, 409)
    assert.equal((await runtime.request(projectsPath, 'archive-project-recovery')).status, 200)
  } finally { runtime.close() }
})

test('archive HTTP policies preserve read/history errors and the seed empty history contract', async () => {
  const runtime = await fixture()
  const reset = (scene: string) => runtime.request('/__preview/reset', 'archive-read', { scene, pageId: scene.startsWith('project-archives-') ? 'page-resource' : 'settings-archives' })
  try {
    const first = (await reset('settings-archives-read-failed')).body
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal((await runtime.request('/api/serve/sessions?archived=true', 'archive-read')).status, 503)
      assert.equal((await runtime.request('/api/content/projects?includeArchived=true', 'archive-read')).status, 503)
    }
    assert.equal((await runtime.request('/api/serve/sessions', 'archive-read')).body.sessions.length, 1)
    assert.equal((await runtime.request('/api/content/projects', 'archive-read')).body.projects.length, 1)
    const failed = (await reset('project-archives-history-failed')).body.sessions.find((session: { archived: boolean }) => session.archived)
    for (let attempt = 0; attempt < 2; attempt += 1) assert.deepEqual(await runtime.request(`/api/serve/history/${failed.session_id}`, 'archive-read'), { status: 503, body: { detail: PREVIEW_ARCHIVE.historyFailure } })
    const foreign = first.sessions.find((session: { archived: boolean }) => session.archived)
    assert.equal((await runtime.request(`/api/serve/history/${foreign.session_id}`, 'foreign')).status, 404)
    const emptyHistory = (await reset('project-archives-history-empty')).body.sessions.find((session: { archived: boolean }) => session.archived)
    assert.deepEqual((await runtime.request(`/api/serve/history/${emptyHistory.session_id}`, 'archive-read')).body.turns, [])
    const empty = (await reset('settings-archives-empty')).body
    assert.equal(empty.projects.length, 1)
    assert.equal((await runtime.request('/api/serve/sessions?archived=true', 'archive-read')).body.sessions.length, 0)
    assert.equal((await runtime.request('/api/content/projects?includeArchived=true', 'archive-read')).body.projects.length, 1)
    await reset('settings-archives-read-pending')
    const reading = runtime.request('/api/serve/sessions?archived=true', 'archive-read')
    const before = Date.now()
    assert.equal((await reading).body.sessions.length, 2)
    assert.ok(Date.now() - before >= PREVIEW_ARCHIVE.delayMs - 50)
  } finally { runtime.close() }
})

test('archive mutation errors do not consume fail-once for foreign identity, invalid input or idempotent restoration', async () => {
  const runtime = await fixture()
  const method = async (path: string, verb: string, instance: string, body?: unknown) => {
    const response = await fetch(runtime.base + path, { method: verb, headers: { 'x-preview-instance': instance, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const state = (await runtime.request('/__preview/reset', 'archive-write', { scene: 'settings-archives-write-failed', pageId: 'settings-archives' })).body
    const task = state.sessions.find((session: { archived: boolean }) => session.archived)
    const active = state.sessions.find((session: { archived: boolean }) => !session.archived)
    assert.equal((await method(`/api/serve/sessions/${task.session_id}`, 'DELETE', 'foreign')).status, 404)
    assert.equal((await method(`/api/serve/sessions/${task.session_id}/archive`, 'PUT', 'archive-write', { archived: 0 })).status, 400)
    assert.equal((await method(`/api/serve/sessions/${active.session_id}/archive`, 'PUT', 'archive-write', { archived: false })).status, 200)
    assert.equal((await method(`/api/serve/sessions/${task.session_id}`, 'DELETE', 'archive-write')).status, 503)
    assert.equal((await runtime.request(`/api/serve/history/${task.session_id}`, 'archive-write')).status, 200)
    assert.deepEqual(await method(`/api/serve/sessions/${task.session_id}`, 'DELETE', 'archive-write'), { status: 200, body: { ok: true, session_id: task.session_id } })
    const approvalState = (await runtime.request('/__preview/reset', 'archive-write', { scene: 'conversation-approval', pageId: 'page-conversation' })).body
    const approvalSession = approvalState.sessions.find((session: { archived: boolean }) => !session.archived)
    const turn = await runtime.request(`/api/serve/sessions/${approvalSession.session_id}/turns`, 'archive-write', { input: [{ type: 'text', text: 'running archive fence' }] })
    assert.equal(turn.status, 200)
    const deadline = performance.now() + CONVERSATION_STATE_TIMEOUT_MS
    let waiting
    do {
      waiting = (await runtime.request('/api/serve/sessions/open', 'archive-write', { resume_session_id: approvalSession.session_id })).body
      if (waiting.running && waiting.last_turn_status === 'waiting' && waiting.pending_hil.length === 1) break
      assert.ok(performance.now() < deadline, 'Expected a live turn awaiting manual approval')
      await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
    } while (performance.now() < deadline)
    assert.equal(waiting.running, true)
    assert.equal(waiting.last_turn_status, 'waiting')
    assert.equal(waiting.active_turn_id, turn.body.turn_id)
    assert.equal(waiting.pending_hil.length, 1)
    assert.deepEqual(await method(`/api/serve/sessions/${approvalSession.session_id}`, 'DELETE', 'archive-write'), { status: 409, body: { ok: false, error: 'session_running' } })
    assert.deepEqual(await method(`/api/serve/sessions/${approvalSession.session_id}/archive`, 'PUT', 'archive-write', { archived: true }), { status: 409, body: { ok: false, error: 'session_running' } })
    const retained = (await runtime.request('/api/serve/sessions/open', 'archive-write', { resume_session_id: approvalSession.session_id })).body
    assert.equal(retained.running, true)
    assert.equal(retained.last_turn_status, 'waiting')
    assert.equal(retained.active_turn_id, turn.body.turn_id)
    assert.deepEqual(retained.pending_hil, waiting.pending_hil)
    const project = state.projects.find((project: { archived_at?: number }) => project.archived_at != null)
    const reset = (await runtime.request('/__preview/reset', 'archive-write', { scene: 'settings-archives-states', pageId: 'settings-archives' })).body
    assert.equal((await runtime.request(`/api/content/projects/${project.id}/archive`, 'archive-write', { archived: false })).status, 400)
    assert.equal(reset.projects.length, 3)
  } finally { runtime.close() }
})

test('archive delayed responses cancel on reset/disconnect while accepted project deletion survives a lost receipt', async () => {
  const runtime = await fixture()
  const reset = (scene = 'settings-archives-write-pending') => runtime.request('/__preview/reset', 'archive-wait', { scene, pageId: scene.startsWith('project-archives-') ? 'page-resource' : 'settings-archives' })
  const put = (id: string, signal?: AbortSignal) => fetch(`${runtime.base}/api/serve/sessions/${id}/archive`, { method: 'PUT', headers: { 'x-preview-instance': 'archive-wait', 'content-type': 'application/json' }, body: JSON.stringify({ archived: false }), signal })
  try {
    const initial = (await reset()).body
    const task = initial.sessions.find((session: { archived: boolean }) => session.archived)
    const arrived = once(runtime.server, 'request')
    const waiting = put(task.session_id)
    await arrived
    assert.equal((await runtime.request('/api/serve/sessions?archived=true', 'archive-wait')).body.sessions.length, 2)
    await reset()
    const cancelled = await waiting
    assert.equal(cancelled.status, 410)
    const state = (await runtime.request('/__preview/state', 'archive-wait')).body
    const current = state.sessions.find((session: { archived: boolean }) => session.archived)
    const controller = new AbortController()
    const connection = once(runtime.server, 'request')
    const disconnected = put(current.session_id, controller.signal)
    const request = await connection
    const closed = once(request[1], 'close')
    const rejected = assert.rejects(disconnected, { name: 'AbortError' })
    controller.abort(); await rejected; await closed
    await new Promise(resolve => setTimeout(resolve, PREVIEW_ARCHIVE.delayMs))
    assert.equal((await runtime.request('/api/serve/sessions?archived=true', 'archive-wait')).body.sessions.length, 2)
    const project = state.projects.find((project: { archived_at?: number }) => project.archived_at != null)
    const accepted = await fetch(`${runtime.base}/api/content/projects/${project.id}`, { method: 'DELETE', headers: { 'x-preview-instance': 'archive-wait' } })
    assert.equal(accepted.status, 202)
    const operation = (await accepted.json()).operation
    assert.equal((await runtime.request(`/api/content/operations/${operation}`, 'foreign')).status, 404)
    await new Promise(resolve => setTimeout(resolve, PREVIEW_ARCHIVE.delayMs + 350))
    assert.deepEqual((await runtime.request(`/api/content/operations/${operation}`, 'archive-wait')).body.result, { id: project.id, removed: true, files_kept: true })
    assert.equal((await runtime.request(`/api/resource/read?project=${project.id}&path=readme.md`, 'archive-wait')).status, 404)
    const old = await fetch(`${runtime.base}/api/content/projects/${state.projects[0].id}`, { method: 'DELETE', headers: { 'x-preview-instance': 'archive-wait' } })
    const oldOperation = (await old.json()).operation
    await reset()
    assert.equal((await runtime.request(`/api/content/operations/${oldOperation}`, 'archive-wait')).status, 404)
    await reset('project-archives-history-pending')
    const historyState = (await runtime.request('/__preview/state', 'archive-wait')).body
    const historyTask = historyState.sessions.find((session: { archived: boolean }) => session.archived)
    const historyArrived = once(runtime.server, 'request')
    const history = runtime.request(`/api/serve/history/${historyTask.session_id}`, 'archive-wait')
    await historyArrived
    await reset()
    assert.equal((await history).status, 410)
  } finally { runtime.close() }
})

test('preview roots use only the current instance ledger and explicit disposal releases capacity without creating unknown instances', async () => {
  const runtime = await fixture()
  const remove = (instance?: string) => fetch(runtime.base + '/__preview/state' + (instance ? `?previewInstance=${instance}` : ''), { method: 'DELETE' })
  try {
    assert.equal((await remove('never-created')).status, 404)
    assert.equal((await remove()).status, 400)
    const state = (await runtime.request('/__preview/reset', 'roots-owner', { scene: 'settings-archives-states', pageId: 'settings-archives' })).body
    const registered = state.projects.map((project: { root: string }) => project.root)
    const bridge = createPreviewBridge({ instance: 'roots-owner', scene: 'settings-archives-states', preferences: state.preferences, storage: state.storage, request: (input, init) => fetch(new URL(String(input), runtime.base), init) })
    assert.equal(await bridge.syncAuthorizedRoots('workspace', ['/preview/workspace', ...registered]), true)
    assert.equal(await bridge.addAuthorizedRoot('session', '/preview/workspace'), true)
    assert.equal(await bridge.addAuthorizedRoot('workspace', '/host/private-token'), false)
    for (const body of [{ scope: 'workspace', mode: 'add', roots: ['/host/private-token'] }, { scope: 'workspace', mode: 'replace', roots: ['/preview/virtual-home'] }, { scope: 'external', mode: 'replace', roots: ['/preview/workspace'] }, { scope: 'workspace', mode: 'replace', roots: [registered[1]] }]) {
      const instance = body.roots[0] === registered[1] ? 'roots-other' : 'roots-owner'
      const invalid = await runtime.request(PREVIEW_ROOTS_PATH, instance, body)
      assert.equal(invalid.status, 422)
      assert.deepEqual(invalid.body, { ok: false })
    }
    const diagnostics = (await runtime.request('/__preview/state', 'roots-owner')).body.diagnostics
    assert.deepEqual(diagnostics.roots, { workspace: 4, session: 1, external: 0 })
    assert.equal(JSON.stringify(diagnostics).includes('/host/private-token'), false)
    await runtime.request('/__preview/reset', 'roots-owner', { scene: 'settings-archives-states', pageId: 'settings-archives' })
    assert.deepEqual((await runtime.request('/__preview/state', 'roots-owner')).body.diagnostics.roots, { workspace: 0, session: 0, external: 0 })
    assert.equal((await remove('roots-owner')).status, 200)
    assert.equal((await remove('roots-owner')).status, 404)
    assert.equal((await runtime.request('/__preview/state', 'roots-other')).status, 200)
    for (let index = 0; index < 99; index += 1) assert.equal((await runtime.request('/__preview/state', `capacity-${index}`)).status, 200)
    assert.equal((await runtime.request('/__preview/state', 'over-capacity')).status, 429)
    assert.equal((await remove('capacity-0')).status, 200)
    assert.equal((await runtime.request('/__preview/state', 'after-disposal')).status, 200)
  } finally { runtime.close() }
})

test('storage real workspace clients persist only the configured virtual root', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  try {
    const initial = await loadWorkspaceRoot()
    assert.deepEqual(initial, { root: '/preview/workspace', configured: '' }, 'real workspace GET must not return unknown 501')
    const bootstrap = (await runtime.request('/__preview/state', 'default')).body.storage
    const choice = bootstrap.choices[0]
    const saved = await saveWorkspaceRoot(choice.path)
    assert.deepEqual(saved, { ok: true, error: undefined, state: { ...initial, configured: choice.path, restartRequired: true } })
    assert.deepEqual(await loadWorkspaceRoot(), { ...initial, configured: choice.path })
    assert.equal((await runtime.request('/__preview/state', 'default')).body.storage.config.configured, false)
  } finally { globalThis.window = originalWindow; runtime.close() }
})

test('storage HTTP registry isolates instances and reset without migrating VFS, project roots or directory plans', async () => {
  const runtime = await fixture()
  const reset = (instance: string, scene = 'settings-storage-states') => runtime.request('/__preview/reset', instance, { scene, pageId: 'settings-storage' })
  const put = async (instance: string, body: unknown) => {
    const response = await fetch(runtime.base + PREVIEW_STORAGE.path, { method: 'PUT', headers: { 'x-preview-instance': instance, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const first = (await reset('storage-first', 'settings-storage-save-failed')).body
    const second = (await reset('storage-other')).body
    const choice = first.storage.choices[0]
    const initial = (await runtime.request(PREVIEW_STORAGE.path, 'storage-first')).body
    const projectList = (await runtime.request('/api/content/projects', 'storage-first')).body
    const directory = (await runtime.request('/api/content/projects/directory?name=Storage%20project', 'storage-first')).body
    const filePath = '/api/resource/read?project=preview-project&path=readme.md'
    const file = (await runtime.request(filePath, 'storage-first')).body
    assert.equal(first.storage.config.configured, false)
    assert.notEqual(choice.path, second.storage.choices[0].path)
    assert.deepEqual((await runtime.request(PREVIEW_STORAGE.path, 'storage-first')).body, initial)
    for (const body of [{}, { root: false }, { root: '/Users/private' }, { root: 'C:\\Users\\private' }, { root: second.storage.choices[0].path }, { root: choice.path + '/..' }]) assert.equal((await put('storage-first', body)).status, 422)
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, 'storage-first', { root: choice.path })).status, 501)
    const failed = await put('storage-first', { root: choice.path })
    assert.deepEqual(failed, { status: 503, body: { detail: PREVIEW_STORAGE.writeFailure } })
    assert.deepEqual((await runtime.request(PREVIEW_STORAGE.path, 'storage-first')).body, initial)
    assert.deepEqual(await put('storage-first', { root: choice.path }), { status: 200, body: { ...initial, configured: choice.path, restartRequired: true } })
    assert.deepEqual((await runtime.request(PREVIEW_STORAGE.path, 'storage-first')).body, { ...initial, configured: choice.path })
    assert.deepEqual((await runtime.request('/api/content/projects', 'storage-first')).body, projectList)
    assert.deepEqual((await runtime.request('/api/content/projects/directory?name=Storage%20project', 'storage-first')).body, directory)
    assert.deepEqual((await runtime.request(filePath, 'storage-first')).body, file)
    assert.deepEqual((await runtime.request(PREVIEW_STORAGE.path, 'storage-other')).body, initial)
    assert.deepEqual((await put('storage-first', { root: '' })).body, { ...initial, restartRequired: false })
    const refreshed = (await reset('storage-first')).body
    assert.notEqual(refreshed.storage.choices[0].path, choice.path)
    assert.equal((await put('storage-first', { root: choice.path })).status, 422)
    assert.deepEqual((await runtime.request(PREVIEW_STORAGE.path, 'storage-first')).body, initial)
  } finally { runtime.close() }
})

test('storage delayed HTTP writes are cancelled by reset or disconnect and cannot leak a stale configuration', async () => {
  const runtime = await fixture()
  const reset = () => runtime.request('/__preview/reset', 'storage-wait', { scene: 'settings-storage-save-pending', pageId: 'settings-storage' })
  const put = (root: string, signal?: AbortSignal) => fetch(runtime.base + PREVIEW_STORAGE.path, { method: 'PUT', headers: { 'x-preview-instance': 'storage-wait', 'content-type': 'application/json' }, body: JSON.stringify({ root }), signal })
  try {
    const old = (await reset()).body.storage.choices[0].path
    const arrived = once(runtime.server, 'request')
    const waiting = put(old)
    await arrived
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, 'storage-wait')).body.configured, '')
    const current = (await reset()).body.storage.choices[0].path
    const cancelled = await waiting
    assert.equal(cancelled.status, 410)
    assert.deepEqual(await cancelled.json(), { detail: PREVIEW_STORAGE.disposed })
    const controller = new AbortController()
    const connection = once(runtime.server, 'request')
    const disconnected = put(current, controller.signal)
    const accepted = await connection
    const closed = once(accepted[1], 'close')
    const rejected = assert.rejects(disconnected, { name: 'AbortError' })
    controller.abort()
    await rejected
    await closed
    await new Promise(resolve => setTimeout(resolve, PREVIEW_STORAGE.delayMs))
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, 'storage-wait')).body.configured, '')
    const saved = await put(current)
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).configured, current)
    assert.equal((await runtime.request(PREVIEW_STORAGE.path, 'storage-wait')).body.configured, current)
  } finally { runtime.close() }
})

test('file settings real configure client persists policy without pretending to scan or delete history', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  try {
    await runtime.request('/__preview/reset', 'default', { scene: 'settings-files-states', pageId: 'settings-files' })
    const initial = await loadFileVersionSettings()
    assert.ok(initial)
    const policy = { mode: initial.mode, max_versions_per_file: 42, max_file_size_kb: 2048, include_patterns: initial.include_patterns, ignore_patterns: initial.ignore_patterns }
    const saved = await saveFileVersionSettings(policy)
    assert.equal(saved.ok, true, 'real configure client must consume POST settings rather than unknown 501')
    if (!saved.ok) return
    assert.deepEqual(saved.result, { ...policy, added_files: 0, removed_files: 0, added_paths: [], removed_paths: [], delete_versions: 0, delete_deliveries: 0, affected_files: 0, token: '', migration_required: false })
    assert.deepEqual(await loadFileVersionSettings(), { ...initial, ...policy })
  } finally { globalThis.window = originalWindow; runtime.close() }
})

test('file settings HTTP validates before fail-once and preserves instance, VFS and version history boundaries', async () => {
  const runtime = await fixture()
  const reset = (instance: string, scene = 'settings-files-states') => runtime.request('/__preview/reset', instance, { scene, pageId: 'settings-files' })
  try {
    await reset('file-policy', 'settings-files-save-failed')
    const initial = (await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy')).body
    const openedPath = '/api/workbench/open?project=preview-project&path=readme.md'
    const opened = (await runtime.request(openedPath, 'file-policy')).body
    const versionsPath = `/api/resource/files/${encodeURIComponent(opened.versioning.file_id)}/versions?project=preview-project`
    const history = (await runtime.request(versionsPath, 'file-policy')).body
    const policy = { mode: 'blacklist', max_versions_per_file: 2, max_file_size_kb: 2048, include_patterns: '*.md\n*.py', ignore_patterns: '*.bak' }
    const invalid = await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy', { ...policy, max_versions_per_file: false })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'invalid_version_limit')
    const unsupported = await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy', { ...policy, preview_token: 'not-real-token' })
    assert.equal(unsupported.status, 501)
    assert.equal(unsupported.body.error.code, PREVIEW_FILE_SETTINGS.unsupported)
    assert.equal((await runtime.request(PREVIEW_FILE_SETTINGS.path + '/preview', 'file-policy', policy)).status, 501)
    const failed = await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy', policy)
    assert.equal(failed.status, 503)
    assert.deepEqual(failed.body, { error: { code: PREVIEW_FILE_SETTINGS.writeFailure, message: PREVIEW_FILE_SETTINGS.writeFailure, details: {} } })
    assert.deepEqual((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy')).body, initial)
    const saved = await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy', policy)
    assert.equal(saved.status, 200)
    assert.equal(saved.body.token, '')
    assert.equal(saved.body.delete_versions, 0)
    assert.equal(saved.body.delete_deliveries, 0)
    assert.equal(saved.body.affected_files, 0)
    const loaded = (await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy')).body
    assert.deepEqual(loaded, { ...initial, ...policy, include_patterns: ['*.md', '*.py'], ignore_patterns: ['*.bak'] })
    assert.deepEqual((await runtime.request(openedPath, 'file-policy')).body, opened)
    assert.deepEqual((await runtime.request(versionsPath, 'file-policy')).body, history)
    await reset('file-other')
    assert.deepEqual((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-other')).body, initial)
    await reset('file-policy')
    assert.deepEqual((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-policy')).body, initial)
  } finally { runtime.close() }
})

test('file settings delayed HTTP writes retain the previous policy and reset cancels an old write instead of leaking it', async () => {
  const runtime = await fixture()
  const reset = () => runtime.request('/__preview/reset', 'file-wait', { scene: 'settings-files-save-pending', pageId: 'settings-files' })
  try {
    await reset()
    const initial = (await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait')).body
    const policy = { mode: initial.mode, max_versions_per_file: 37, max_file_size_kb: 2048, include_patterns: initial.include_patterns, ignore_patterns: [] }
    const arrived = once(runtime.server, 'request')
    const oldWrite = runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait', policy)
    await arrived
    assert.deepEqual((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait')).body, initial)
    await reset()
    const cancelled = await oldWrite
    assert.equal(cancelled.status, 410)
    assert.equal(cancelled.body.error.code, PREVIEW_FILE_SETTINGS.disposed)
    assert.deepEqual((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait')).body, initial)
    const disconnect = new AbortController()
    const connection = once(runtime.server, 'request')
    const disconnected = fetch(runtime.base + PREVIEW_FILE_SETTINGS.path, {
      method: 'POST', headers: { 'x-preview-instance': 'file-wait', 'content-type': 'application/json' },
      body: JSON.stringify({ ...policy, max_versions_per_file: 12 }), signal: disconnect.signal,
    })
    const closedConnection = await connection
    const closed = once(closedConnection[1], 'close')
    const rejected = assert.rejects(disconnected, { name: 'AbortError' })
    disconnect.abort()
    await rejected
    await closed
    await new Promise(resolve => setTimeout(resolve, PREVIEW_FILE_SETTINGS.delayMs))
    assert.deepEqual((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait')).body, initial)
    const saved = await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait', policy)
    assert.equal(saved.status, 200)
    assert.equal((await runtime.request(PREVIEW_FILE_SETTINGS.path, 'file-wait')).body.max_versions_per_file, 37)
  } finally { runtime.close() }
})

test('model settings real clients consume isolated read-only redacted profile and provider inventories', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  try {
    await runtime.request('/__preview/reset', 'default', { scene: 'settings-models-states', pageId: 'settings-models' })
    const profiles = await getPersonalApiProfiles()
    assert.ok(profiles, 'real getPersonalApiProfiles must consume GET model-profiles rather than unknown 501')
    assert.equal(profiles.profiles.length, 1)
    const profile = profiles.profiles[0]
    assert.match(profile.id, /^personal-[a-f0-9]{32}$/)
    assert.equal(profile.enabled, false)
    assert.equal(profile.has_api_key, false)
    assert.deepEqual(profiles.enabled_profile_ids, [])
    assert.ok(profile.selected_models.length > 0)
    assert.deepEqual(await getModelProviders(), { providers: [] })
    assert.equal((await getModels())?.available_models.some(model => model.profile_id === profile.id), false)
    const rejected = await setPersonalApiProfileEnabled(profile.id, true)
    assert.equal(rejected.ok, false)
    if (!rejected.ok) assert.equal(rejected.status, 501)
    assert.deepEqual(await getPersonalApiProfiles(), profiles)
  } finally { globalThis.window = originalWindow; runtime.close() }
})

test('model profile HTTP policies keep read errors persistent and reject credentials, discovery and mutations without changing samples', async () => {
  const runtime = await fixture()
  const reset = (instance: string, scene: string) => runtime.request('/__preview/reset', instance, { scene, pageId: 'settings-models' })
  const mutate = (instance: string, path: string, method: string) => fetch(runtime.base + path, {
    method, headers: { 'x-preview-instance': instance, 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: 'never-store-this-secret', headers: { authorization: 'never-store-this-secret' }, enabled: true }),
  })
  try {
    await reset('model-http', 'settings-models-states')
    const initial = (await runtime.request(PREVIEW_MODELS.profilesPath, 'model-http')).body
    const profile = initial.profiles[0]
    assert.deepEqual(profile, { ...PREVIEW_MODEL_SAMPLE, id: profile.id })
    for (const [path, method] of [
      [PREVIEW_MODELS.profilesPath, 'POST'],
      [`${PREVIEW_MODELS.profilesPath}/${profile.id}`, 'PUT'],
      [`${PREVIEW_MODELS.profilesPath}/${profile.id}`, 'DELETE'],
      [`${PREVIEW_MODELS.profilesPath}/${profile.id}/enabled`, 'POST'],
      [`${PREVIEW_MODELS.profilesPath}/${profile.id}/models/visibility`, 'POST'],
      [`${PREVIEW_MODELS.profilesPath}/models`, 'POST'],
      [`${PREVIEW_MODELS.profilesPath}/probe`, 'POST'],
    ]) {
      const response = await mutate('model-http', path, method)
      assert.equal(response.status, 501, `${method} ${path}`)
      assert.deepEqual(await response.json(), { detail: PREVIEW_MODELS.readOnly })
    }
    assert.deepEqual((await runtime.request(PREVIEW_MODELS.profilesPath, 'model-http')).body, initial)
    await reset('model-other', 'settings-models-states')
    const foreign = await mutate('model-other', `${PREVIEW_MODELS.profilesPath}/${profile.id}/enabled`, 'POST')
    assert.equal(foreign.status, 404)
    assert.deepEqual(await foreign.json(), { detail: PREVIEW_MODELS.notFound })
    await reset('model-http', 'settings-models-states')
    assert.notEqual((await runtime.request(PREVIEW_MODELS.profilesPath, 'model-http')).body.profiles[0].id, profile.id)
    assert.equal((await mutate('model-http', `${PREVIEW_MODELS.profilesPath}/${profile.id}`, 'PUT')).status, 404)
    const diagnostics = (await runtime.request('/__preview/state', 'model-other')).body
    assert.equal(JSON.stringify(diagnostics).includes('never-store-this-secret'), false)
    await reset('model-empty', 'settings-models-empty')
    assert.deepEqual((await runtime.request(PREVIEW_MODELS.profilesPath, 'model-empty')).body.profiles, [])
    await reset('model-failed', 'settings-models-failed')
    for (const attempt of [0, 1]) {
      const result = await runtime.request(PREVIEW_MODELS.profilesPath, 'model-failed')
      assert.equal(result.status, 503, `attempt ${attempt}`)
      assert.deepEqual(result.body, { detail: PREVIEW_MODELS.readFailure })
    }
    assert.deepEqual((await runtime.request(PREVIEW_MODELS.providersPath, 'model-failed')).body, { providers: [] })
  } finally { runtime.close() }
})

test('model delayed HTTP reads return the same sample on reload while reset cancels old flights and rotates profile identity', async () => {
  const runtime = await fixture()
  const reset = (scene: string) => runtime.request('/__preview/reset', 'model-wait', { scene, pageId: 'settings-models' })
  try {
    await reset('settings-models-pending')
    const initial = await runtime.request(PREVIEW_MODELS.profilesPath, 'model-wait')
    assert.equal(initial.status, 200)
    assert.deepEqual(initial.body.profiles[0], { ...PREVIEW_MODEL_SAMPLE, id: initial.body.profiles[0].id })
    assert.deepEqual((await runtime.request(PREVIEW_MODELS.profilesPath, 'model-wait')).body, initial.body)
    const arrived = once(runtime.server, 'request')
    const oldRead = runtime.request(PREVIEW_MODELS.profilesPath, 'model-wait')
    await arrived
    await reset('settings-models-states')
    const cancelled = await oldRead
    assert.equal(cancelled.status, 410)
    assert.deepEqual(cancelled.body, { detail: PREVIEW_MODELS.disposed })
    const current = (await runtime.request(PREVIEW_MODELS.profilesPath, 'model-wait')).body
    assert.notEqual(current.profiles[0].id, initial.body.profiles[0].id)
    assert.equal(JSON.stringify(cancelled.body).includes(initial.body.profiles[0].id), false)
  } finally { runtime.close() }
})


test('real PDF region client receives an explicitly unavailable manifest fenced by VFS revision and page range', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'pdf-regions' } })
  try {
    const opened = await runtime.request('/api/workbench/open?project=preview-project&path=sample.pdf', 'pdf-regions')
    const revision = opened.body.revision
    const manifest = (await runtime.request(`/api/workbench/pdf/regions?${new URLSearchParams({ project: 'preview-project', path: 'sample.pdf', revision, start_page: '1', end_page: '1' })}`, 'pdf-regions')).body
    assert.equal(manifest.source_revision, revision)
    assert.equal(manifest.schema_version, 1)
    assert.equal(manifest.detector_version, 'preview-unavailable')
    assert.equal(manifest.coordinate_space, 'pdfjs_normalized')
    assert.ok(manifest.page_count >= 1)
    assert.deepEqual(manifest.unavailable_pages, [1])
    assert.deepEqual(manifest.pages, [{ page: 1, unavailable: true, regions: [] }])
    const query = new URLSearchParams({ project: 'preview-project', path: 'sample.pdf', revision, start_page: '1', end_page: '1' })
    const check = async (values: Record<string, string>, status: number, detail: string) => {
      const response = await runtime.request(`/api/workbench/pdf/regions?${new URLSearchParams({ ...Object.fromEntries(query), ...values })}`, 'pdf-regions')
      assert.equal(response.status, status)
      assert.equal(response.body.detail, detail)
    }
    await check({ revision: 'sha256:stale' }, 409, 'source_revision_conflict')
    const markdown = await runtime.request('/api/workbench/open?project=preview-project&path=readme.md', 'pdf-regions')
    await check({ path: 'readme.md', revision: markdown.body.revision }, 415, 'pdf_source_invalid')
    const invalidRanges: Record<string, string>[] = [{ start_page: '0' }, { end_page: String(manifest.page_count + 1) }, { start_page: '2', end_page: '1' }, { start_page: '1.5' }]
    for (const values of invalidRanges) await check(values, 422, 'literature_page_range_invalid')
    for (const field of ['project', 'path', 'revision', 'start_page', 'end_page']) {
      const incomplete = new URLSearchParams(query)
      incomplete.delete(field)
      const response = await runtime.request(`/api/workbench/pdf/regions?${incomplete}`, 'pdf-regions')
      assert.equal(response.status, 422)
      assert.deepEqual(response.body.detail[0].loc, ['query', field])
    }
    const missing = new URLSearchParams(query)
    missing.set('path', 'absent.pdf')
    assert.equal((await runtime.request(`/api/workbench/pdf/regions?${missing}`, 'pdf-regions')).status, 404)
    assert.equal((await runtime.request(`/api/workbench/pdf/regions/not-real/image?${query}`, 'pdf-regions')).status, 501)
    await runtime.request('/api/resource/node', 'pdf-regions', { project: 'preview-project', action: 'rename', path: 'sample.pdf', name: 'renamed.pdf' })
    const renamed = (await runtime.request(`/api/workbench/pdf/regions?${new URLSearchParams({ ...Object.fromEntries(query), path: 'renamed.pdf' })}`, 'pdf-regions')).body
    assert.deepEqual(renamed, manifest)
    await runtime.request('/api/resource/write', 'pdf-regions', { project: 'preview-project', path: 'renamed.pdf', content: 'not a valid PDF document' })
    const broken = await runtime.request('/api/workbench/open?project=preview-project&path=renamed.pdf', 'pdf-regions')
    const corruptQuery = new URLSearchParams({ ...Object.fromEntries(query), path: 'renamed.pdf', revision: broken.body.revision })
    const corrupt = await runtime.request(`/api/workbench/pdf/regions?${corruptQuery}`, 'pdf-regions')
    assert.equal(corrupt.status, 422)
    assert.equal(corrupt.body.detail, 'pdf_parse_failed')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    runtime.close()
  }
})

test('document content policies preserve VFS bytes, identity scope and explicit retry semantics', async () => {
  const runtime = await fixture()
  try {
    for (const viewer of ['markdown', 'pdf', 'code', 'image', 'office']) {
      const pageId = `viewer-${viewer}`
      const sample = PREVIEW_DOCUMENTS.find(document => document.viewer === viewer)!
      const query = new URLSearchParams({ project: 'preview-project', path: sample.path })
      const read = (instance: string, route = '/api/workbench/content') => fetch(`${runtime.base}${route}?${query}`, { headers: { 'x-preview-instance': instance } })
      const normal = await read('content-normal')
      const bytes = new Uint8Array(await normal.arrayBuffer())
      const revision = normal.headers.get('etag')
      for (const [suffix, mode] of [['failed', 'failed'], ['retry', 'fail-once']] as const) {
        const instance = `content-${viewer}-${suffix}`
        assert.equal((await runtime.request('/__preview/reset', instance, { scene: `${pageId}-${suffix}`, pageId })).status, 200)
        assert.equal((await read(instance, '/api/workbench/open')).status, 200)
        const failure = await read(instance)
        assert.equal(failure.status, 503)
        assert.equal((await failure.json()).detail, 'preview_content_unavailable')
        const retry = await read(instance)
        assert.equal(retry.status, mode === 'failed' ? 503 : 200)
        if (retry.ok) {
          assert.deepEqual(new Uint8Array(await retry.arrayBuffer()), bytes)
          assert.equal(retry.headers.get('etag'), revision)
        } else await retry.arrayBuffer()
        const unrelated = await fetch(`${runtime.base}/api/workbench/content?project=preview-project&path=${sample.path === 'hello.py' ? 'readme.md' : 'hello.py'}`, { headers: { 'x-preview-instance': instance } })
        assert.equal(unrelated.status, 200)
        await unrelated.arrayBuffer()
        assert.equal((await read(instance, '/api/resource/raw')).status, 200)
        assert.equal((await read('content-normal')).status, 200)
        await runtime.request('/__preview/reset', instance, { scene: `${pageId}-${suffix}`, pageId })
        assert.equal((await read(instance)).status, 503)
        if (mode === 'failed') {
          const name = `renamed-${sample.path}`
          assert.equal((await runtime.request('/api/resource/node', instance, { project: 'preview-project', action: 'rename', path: sample.path, name })).status, 200)
          const renamedQuery = new URLSearchParams({ project: 'preview-project', path: name })
          const renamed = await fetch(`${runtime.base}/api/workbench/content?${renamedQuery}`, { headers: { 'x-preview-instance': instance } })
          assert.equal(renamed.status, 503)
          await renamed.arrayBuffer()
          assert.equal((await runtime.request('/api/resource/node', instance, { project: 'preview-project', action: 'create_document', name: sample.path, content: 'A distinct new file identity.' })).status, 200)
          assert.equal((await read(instance)).status, 200)
        }
      }
    }
  } finally { runtime.close() }
})

test('content recovery keeps target bytes and versions while other instances and projects remain independent', async () => {
  const runtime = await fixture()
  try {
    for (const kind of ['code', 'image', 'office']) {
      const instance = `content-recovery-${kind}`
      const pageId = `viewer-${kind}`
      const sample = PREVIEW_DOCUMENTS.find(document => document.viewer === kind)!
      const query = new URLSearchParams({ project: PREVIEW_PROJECT_ID, path: sample.path })
      const get = () => fetch(`${runtime.base}/api/workbench/content?${query}`, { headers: { 'x-preview-instance': instance } })
      assert.equal((await runtime.request('/__preview/reset', instance, { pageId, scene: `${pageId}-failed` })).status, 200)
      const before = (await runtime.request(`/api/workbench/open?${query}`, instance)).body
      for (const attempt of [0, 1]) {
        const failed = await get()
        assert.equal(failed.status, 503, `original retry ${attempt}`)
        await failed.arrayBuffer()
      }
      const project = await createProject(runtime, `Independent ${kind}`, instance)
      await runtime.request('/api/resource/write', instance, { project: project.id, path: 'independent.txt', content: 'Independent project bytes.' })
      const independent = await fetch(`${runtime.base}/api/workbench/content?${new URLSearchParams({ project: project.id, path: 'independent.txt' })}`, { headers: { 'x-preview-instance': instance } })
      assert.equal(independent.status, 200)
      assert.equal(await independent.text(), 'Independent project bytes.')
      const normal = await fetch(`${runtime.base}/api/workbench/content?${query}`, { headers: { 'x-preview-instance': 'normal-content-reference' } })
      assert.equal(normal.status, 200)
      const expected = new Uint8Array(await normal.arrayBuffer())
      assert.equal((await runtime.request(PREVIEW_CONTENT.recoveryPath, 'unrelated-content-instance', {})).status, 409)
      assert.equal((await runtime.request(PREVIEW_CONTENT.recoveryPath, instance, {})).status, 200)
      const recovered = await get()
      assert.equal(recovered.status, 200)
      assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), expected)
      const after = (await runtime.request(`/api/workbench/open?${query}`, instance)).body
      assert.deepEqual(after, before)
      assert.equal((await runtime.request(PREVIEW_CONTENT.recoveryPath, instance, {})).status, 200)
      await runtime.request('/__preview/reset', instance, { pageId, scene: `${pageId}-failed` })
      const reset = await get()
      assert.equal(reset.status, 503)
      await reset.arrayBuffer()
      await runtime.request('/__preview/reset', instance, { pageId, scene: `${pageId}-retry` })
      assert.equal((await runtime.request(PREVIEW_CONTENT.recoveryPath, instance, {})).status, 409)
    }
  } finally { runtime.close() }
})

test('delayed content cannot read an unregistered project after its accepted forget operation', async () => {
  const runtime = await fixture()
  const instance = 'content-forgotten-project'
  const headers = { 'x-preview-instance': instance }
  try {
    await runtime.request('/__preview/reset', instance, { pageId: 'viewer-code', scene: 'viewer-code-pending' })
    const arrived = once(runtime.server, 'request')
    const pending = fetch(`${runtime.base}/api/workbench/content?project=${PREVIEW_PROJECT_ID}&path=hello.py`, { headers })
    await arrived
    const forgotten = await fetch(`${runtime.base}/api/content/projects/${PREVIEW_PROJECT_ID}`, { method: 'DELETE', headers })
    assert.equal(forgotten.status, 202)
    const accepted = await forgotten.json()
    await waitForProjectOperation(runtime, accepted.operation, instance)
    const completed = await pending
    assert.equal(completed.status, 404)
    assert.deepEqual(await completed.json(), { code: 'preview_project_not_found' })
    assert.equal((await runtime.request(`/api/workbench/open?project=${PREVIEW_PROJECT_ID}&path=hello.py`, instance)).status, 404)
  } finally { runtime.close() }
})

test('delayed content reads observe the same current VFS and cannot complete after instance reset', async () => {
  const runtime = await fixture()
  const instance = 'content-delayed'
  const query = new URLSearchParams({ project: 'preview-project', path: 'readme.md' })
  const headers = { 'x-preview-instance': instance }
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'viewer-markdown-pending', pageId: 'viewer-markdown' })
    const opened = await runtime.request(`/api/workbench/open?${query}`, instance)
    const arrived = once(runtime.server, 'request')
    const pending = fetch(`${runtime.base}/api/workbench/content?${query}`, { headers })
    await arrived
    const edited = new TextEncoder().encode('Updated while the preview content read was pending.\n')
    const saved = await fetch(`${runtime.base}/api/workbench/content?${query}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'if-match': `"${opened.body.revision}"` }, body: edited })
    assert.equal(saved.status, 204)
    const completed = await pending
    assert.equal(completed.status, 200)
    assert.equal(completed.headers.get('etag'), saved.headers.get('etag'))
    assert.deepEqual(new Uint8Array(await completed.arrayBuffer()), edited)
    const nextArrived = once(runtime.server, 'request')
    const stale = fetch(`${runtime.base}/api/workbench/content?${query}`, { headers })
    await nextArrived
    await runtime.request('/__preview/reset', instance, { scene: 'viewer-markdown-states', pageId: 'viewer-markdown' })
    const cancelled = await stale
    assert.equal(cancelled.status, 410)
    assert.equal((await cancelled.json()).detail, 'preview_content_cancelled')
    const restored = await fetch(`${runtime.base}/api/workbench/content?${query}`, { headers })
    assert.equal(restored.status, 200)
    assert.equal(new TextDecoder().decode(await restored.arrayBuffer()).includes('Updated while'), false)
  } finally { runtime.close() }
})

test('delayed project content preserves current-path reads across replacement and rejects a path that disappears', async () => {
  const runtime = await fixture()
  const instance = 'content-current-path'
  const headers = { 'x-preview-instance': instance }
  const query = (path: string) => new URLSearchParams({ project: PREVIEW_PROJECT_ID, path })
  try {
    await runtime.request('/__preview/reset', instance, { pageId: 'viewer-code', scene: 'viewer-code-pending' })
    const original = (await runtime.request(`/api/workbench/open?${query('hello.py')}`, instance)).body
    const arrived = once(runtime.server, 'request')
    const pending = fetch(`${runtime.base}/api/workbench/content?${query('hello.py')}`, { headers })
    await arrived
    assert.equal((await runtime.request('/api/resource/node', instance, { project: PREVIEW_PROJECT_ID, action: 'rename', path: 'hello.py', name: 'previous.py' })).status, 200)
    const replacement = 'Replacement bytes at the same path.\n'
    assert.equal((await runtime.request('/api/resource/node', instance, { project: PREVIEW_PROJECT_ID, action: 'create_document', name: 'hello.py', content: replacement })).status, 200)
    const current = (await runtime.request(`/api/workbench/open?${query('hello.py')}`, instance)).body
    assert.notEqual(current.asset_id, original.asset_id)
    const completed = await pending
    assert.equal(completed.status, 200)
    assert.equal(completed.headers.get('etag'), `"${current.revision}"`)
    assert.equal(await completed.text(), replacement)
    const nextArrived = once(runtime.server, 'request')
    const moved = fetch(`${runtime.base}/api/workbench/content?${query('previous.py')}`, { headers })
    await nextArrived
    assert.equal((await runtime.request('/api/resource/node', instance, { project: PREVIEW_PROJECT_ID, action: 'rename', path: 'previous.py', name: 'moved.py' })).status, 200)
    const missing = await moved
    assert.equal(missing.status, 404)
    await missing.arrayBuffer()
  } finally { runtime.close() }
})

test('account HTTP simulation is fenced by instance capability and reset, with no account mutation fallback', async () => {
  const runtime = await fixture()
  try {
    const ready = await runtime.request('/__preview/reset', 'account-first', { scene: 'settings-account-ready', pageId: 'settings-account' })
    assert.equal(ready.status, 200)
    assert.ok(ready.body.account?.capability)
    assert.equal((await runtime.request('/api/auth/status', 'account-first')).body.account_base_url, runtime.base)
    const read = (instance: string, authorization?: string, cookie?: string) => fetch(runtime.base + '/api/account/me', { headers: { 'x-preview-instance': instance, ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) } })
    const credential = ready.body.account.capability
    assert.equal((await read('account-first', undefined, 'session=not-a-preview-capability')).status, 401)
    assert.equal((await read('account-first', 'Bearer real-token-must-not-be-used')).status, 401)
    const profile = await read('account-first', `Bearer ${credential}`)
    assert.equal(profile.status, 200)
    assert.deepEqual(await profile.json(), { user_id: 'preview-account:account-first', nickname: '模拟协作账号（非真实用户）' })
    const credits = await fetch(runtime.base + '/api/account/credits', { headers: { 'x-preview-instance': 'account-first', authorization: `Bearer ${credential}` } })
    assert.equal(credits.status, 503)
    assert.deepEqual(await credits.json(), { code: 'preview_credits_unavailable' })
    assert.equal((await read('account-first', `Bearer ${credential}`)).status, 200)
    await runtime.request('/__preview/reset', 'account-second', { scene: 'settings-account-ready', pageId: 'settings-account' })
    assert.equal((await read('account-second', `Bearer ${credential}`)).status, 401)
    const reset = await runtime.request('/__preview/reset', 'account-first', { scene: 'settings-account-ready', pageId: 'settings-account' })
    assert.notEqual(reset.body.account.capability, credential)
    assert.equal((await read('account-first', `Bearer ${credential}`)).status, 401)
    const mutation = await fetch(runtime.base + '/api/account/profile', { method: 'PATCH', headers: { 'x-preview-instance': 'account-first', authorization: `Bearer ${reset.body.account.capability}`, 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'must not persist' }) })
    assert.equal(mutation.status, 501)
    const failed = await runtime.request('/__preview/reset', 'account-first', { scene: 'settings-account-failed', pageId: 'settings-account' })
    assert.equal((await read('account-first', `Bearer ${failed.body.account.capability}`)).status, 503)
    assert.equal((await read('account-first', `Bearer ${failed.body.account.capability}`)).status, 503)
    const state = await runtime.request('/__preview/state', 'account-first')
    assert.ok(!JSON.stringify(state.body.diagnostics).includes(failed.body.account.capability))
    await runtime.request('/__preview/reset', 'account-first', { scene: 'settings-account-states', pageId: 'settings-account' })
    assert.equal((await runtime.request('/api/auth/status', 'account-first')).body.account_base_url, '')
  } finally { runtime.close() }
})

test('real account client consumes only the isolated HTTP profile contract and preserves failure provenance', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalBase = accountBase()
  const instance = 'account-client'
  globalThis.fetch = (input, init) => {
    assert.ok(String(input).startsWith(runtime.base + '/'))
    return originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': instance } })
  }
  try {
    for (const [scene, mode] of [['settings-account-ready', 'ready'], ['settings-account-failed', 'failed'], ['settings-account-anonymous', 'anonymous'], ['settings-account-states', 'no-base']] as const) {
      const response = await runtime.request('/__preview/reset', instance, { scene, pageId: 'settings-account' })
      const state = await readPreviewAccountState(Response.json(response.body), instance, mode)
      const bridge = createPreviewBridge({ instance, scene, preferences: state.preferences, account: state.account, simulation: { account: mode }, request: globalThis.fetch })
      globalThis.window = { scholarseed: bridge, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, dispatchEvent: () => true } as unknown as Window & typeof globalThis
      setAccountBase(previewAccountBase(runtime.base, state.account))
      const result = await accountMe()
      if (mode === 'ready') {
        assert.equal(result.ok, true)
        if (result.ok) assert.deepEqual(result.data, { user_id: 'preview-account:account-client', nickname: '模拟协作账号（非真实用户）' })
      } else {
        assert.equal(result.ok, false)
        if (!result.ok) {
          if (mode === 'anonymous') assert.equal(result.code, ERR_UNAUTHENTICATED)
          if (mode === 'no-base') assert.equal(result.applicationFailure?.code, 'no_base_url')
          if (mode === 'failed') assert.equal(result.code, 'preview_account_unavailable')
        }
      }
      assert.equal((await bridge.setAuthToken('a-real-token-must-never-be-adopted')).ok, false)
    }
  } finally {
    setAccountBase(originalBase)
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    runtime.close()
  }
})

const PROJECT_POLL_INTERVAL_MS = 10
const PROJECT_TEST_TIMEOUT_MS = 3_000

test('ResourcePanel reads owned version settings and scan summary without enabling retention mutations', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'file-settings' } })
  try {
    const settings = await loadFileVersionSettings()
    assert.ok(settings)
    assert.equal(settings.mode, 'whitelist')
    assert.equal(settings.migration_required, false)
    assert.equal(settings.scan_summary.status, 'idle')
    assert.equal(settings.scan_summary.projects, 1)
    assert.ok(settings.scan_summary.managed > 0)
    assert.ok(settings.include_patterns.includes('*.md'))
    assert.equal(await waitForFileVersionScan(), true)
    const invalid = await runtime.request('/api/serve/settings/file-versions', 'file-settings', { mode: 'blacklist' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'invalid_version_limit')
    assert.deepEqual(await loadFileVersionSettings(), settings)
    assert.equal((await runtime.request('/api/serve/settings/file-versions/preview', 'file-settings', {})).status, 501)
    await runtime.request('/__preview/reset', 'file-settings', { scene: 'empty' })
    assert.equal((await loadFileVersionSettings())?.scan_summary.projects, 0)
    assert.equal((await loadFileVersionSettings())?.scan_summary.managed, 0)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; await runtime.close() }
})

test('scene scoped HTTP search feeds real literature consumers and official web projection without network or imports', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'search-http' } })
  try {
    assert.deepEqual(await listLiteratureSearches(), [])
    assert.equal((await runtime.request('/api/resource/web-search', 'search-http', { query: 'test' })).status, 501)
    await runtime.request('/__preview/reset', 'search-http', { scene: 'viewer-literature_search-states', pageId: 'viewer-literature_search' })
    const tasks = await listLiteratureSearches()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].status, 'completed')
    assert.deepEqual(await loadSearchLibraryStatus(tasks[0].result!.papers, 'preview-project'), [])
    const papers = tasks[0].result!.papers.map(paper => ({ id: paper.paper_id }))
    assert.deepEqual((await runtime.request('/api/literature/searches/result-status', 'search-http', { papers })).body, { items: Object.fromEntries(papers.map(paper => [paper.id, { library: 'absent' }])) })
    assert.equal((await originalFetch(runtime.base + '/api/literature/searches/result-status', { method: 'POST', headers: { 'x-preview-instance': 'other', 'content-type': 'application/json' }, body: JSON.stringify({ papers }) })).status, 422)
    await runtime.request('/__preview/reset', 'search-http', { scene: 'viewer-web_search-states', pageId: 'viewer-web_search' })
    const query = 'reviewed mock query'
    const search = await runtime.request('/api/resource/web-search', 'search-http', { query, limit: 2 })
    assert.equal(search.status, 200)
    const projection = projectOfficialWebSearch(JSON.stringify(search.body), query, search.body.search_id)
    assert.equal(projection.executionEvidenceFound, true)
    assert.equal(projection.candidates.length, 2)
    assert.ok(projection.candidates.every(candidate => new URL(candidate.url).hostname === PREVIEW_SEARCH.hostname))
    assert.equal((await fetch(runtime.base + `/api/resource/web-icon?url=${encodeURIComponent('https://' + PREVIEW_SEARCH.hostname)}`)).status, 204)
    assert.equal((await fetch(runtime.base + '/api/resource/web-icon?url=https://unreviewed.invalid')).status, 404)
    assert.equal((await runtime.request('/api/resource/web-search', 'search-http', { query: '', limit: 0 })).status, 422)
    await runtime.request('/__preview/reset', 'search-http', { scene: 'page-home' })
    assert.deepEqual(await listLiteratureSearches(), [])
    assert.equal((await runtime.request('/api/literature/searches/result-status', 'search-http', { papers })).status, 422)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; await runtime.close() }
})

test('real review consumers share VFS identity, immutable candidate, and fenced idempotent decisions', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'review-ui' } })
  try {
    for (const action of ['accept', 'reject', 'revise'] as const) {
      await runtime.request('/__preview/reset', 'review-ui', { scene: 'viewer-review-states', pageId: 'viewer-review' })
      const batch = await fetchResourceReviewBatchForPath('preview-project', 'readme.md')
      assert.ok(batch)
      const member = batch.members[0]
      const capability = await fetchVersionCapability('preview-project', 'readme.md')
      assert.equal(capability?.file_id, member.file_id)
      assert.equal((await fetchResourceVersions('preview-project', member.file_id))?.total, 1)
      const baseline = await fetchReviewMemberContent('preview-project', batch.id, member.file_id, 'base')
      const candidate = await fetchReviewMemberContent('preview-project', batch.id, member.file_id, 'candidate')
      const current = await fetchReviewMemberCurrent('preview-project', batch.id, member.file_id)
      assert.deepEqual(candidate, new Uint8Array(readFileSync(new URL('./fixtures/readme.modified.md', import.meta.url))))
      assert.deepEqual(current?.content, candidate)
      assert.equal(current?.revision, capability?.disk_revision)
      const decisions = [{ file_id: member.file_id, review_id: member.review_id, pending_revision: member.pending_revision, action, expected_disk_revision: current!.revision, ...(action === 'revise' ? { revised_content: baseline! } : {}) }]
      const result = await decideResourceReviewBatch('preview-project', batch.id, decisions, action)
      assert.equal(result.ok, true)
      assert.equal(result.batch?.state, 'completed')
      assert.deepEqual(await decideResourceReviewBatch('preview-project', batch.id, decisions, action), result)
      assert.equal((await fetchResourceVersions('preview-project', member.file_id))?.total, action === 'reject' ? 1 : 2)
      assert.equal((await fetchVersionCapability('preview-project', 'readme.md'))?.pending, null)
      assert.deepEqual((await fetchReviewMemberCurrent('preview-project', batch.id, member.file_id))?.content, action === 'accept' ? candidate : baseline)
    }
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; await runtime.close() }
})

test('review HTTP keeps failed work pending, fences conflicts, isolates reset, and projects tree indicators', async () => {
  const runtime = await fixture()
  const request = async (path: string, body?: unknown, key?: string) => fetch(runtime.base + path, { headers: { 'x-preview-instance': 'review-fences', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
  const query = '?project=preview-project'
  try {
    await runtime.request('/__preview/reset', 'review-fences', { scene: 'viewer-review-failed', pageId: 'viewer-review' })
    const batch = (await (await request('/api/resource/review-batches' + query)).json()).items[0]
    const member = batch.members[0]
    const tree = await (await request('/api/resource/tree' + query)).json()
    assert.equal(tree.nodes.find((node: { path: string }) => node.path === 'readme.md').version.needs_review, true)
    const current = await request(`/api/resource/review-batches/${batch.id}/members/${encodeURIComponent(member.file_id)}/current${query}`)
    const decision = { file_id: member.file_id, review_id: member.review_id, pending_revision: member.pending_revision, action: 'accept', expected_disk_revision: current.headers.get('X-ScholarSeed-Content-Revision') }
    const commit = `/api/resource/review-batches/${batch.id}/commit${query}`
    assert.equal((await request(commit, { decisions: [decision] })).status, 400)
    assert.equal((await request(commit, { decisions: [{ ...decision, pending_revision: 99 }] }, 'stale')).status, 409)
    assert.equal((await request(commit, { decisions: [{ ...decision, revised_content: '???' }] }, 'invalid')).status, 422)
    const failed = await (await request(commit, { decisions: [decision] }, 'retry')).json()
    assert.equal(failed.batch.state, 'failed')
    assert.ok((await (await request(`/api/resource/files/${encodeURIComponent(member.file_id)}/pending${query}`)).json()).pending)
    assert.equal((await (await request(commit, { decisions: [decision] }, 'retry')).json()).batch.state, 'completed')
    assert.equal((await runtime.request(`/api/resource/review-batches/${batch.id}${query}`, 'other')).status, 404)
    await runtime.request('/__preview/reset', 'review-fences', { scene: 'viewer-review-conflict', pageId: 'viewer-review' })
    assert.equal((await request(`/api/resource/review-batches/${batch.id}${query}`)).status, 404)
    const conflictPath = `/api/resource/files/${encodeURIComponent(member.file_id)}/review/conflict${query}`
    const conflict = await (await request(conflictPath)).json()
    const reconcile = `/api/resource/files/${encodeURIComponent(member.file_id)}/review/reconcile${query}`
    assert.equal((await request(reconcile, { action: 'restore_candidate', token: 'stale' }, 'stale-token')).status, 409)
    assert.deepEqual(await (await request(reconcile, { action: 'restore_candidate', token: conflict.token }, 'restore')).json(), { ok: true })
    assert.equal((await request(conflictPath)).status, 409)
    assert.equal((await request('/api/resource/review-batches?project=unknown')).status, 400)
    assert.equal((await request('/api/resource/review-batches?project=preview-project&limit=0')).status, 422)
    await runtime.request('/__preview/reset', 'review-fences', { scene: 'page-home' })
    assert.deepEqual(await (await request('/api/resource/review-batches' + query)).json(), { items: [], next_cursor: null })
  } finally { await runtime.close() }
})

test('current renderer backend readiness consumes the preview health contract', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'readiness' } })
  try {
    const health = await getBackendHealth()
    assert.equal(health?.ok, true)
    assert.equal(health?.workbench_ready, true)
    assert.equal(health?.service_instance_id, 'preview-readiness')
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) globalThis.window = originalWindow
    else Reflect.deleteProperty(globalThis, 'window')
    await runtime.close()
  }
})

test('real provenance consumer distinguishes ordinary resources from missing project identity without inventing Agent source records', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'provenance' } })
  try {
    assert.equal(await fetchResourceAgentOrigin('preview-project', 'readme.md'), null)
    for (const path of ['readme.md', 'sample.xls', 'missing.md']) {
      const result = await fetch(runtime.base + `/api/resource/agent-origin?${new URLSearchParams({ project: 'preview-project', path })}`)
      assert.equal(result.status, 200)
      assert.equal(await result.json(), null)
    }
    const unknown = await fetch(runtime.base + '/api/resource/agent-origin?project=unknown&path=readme.md')
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { detail: 'unknown_project' })
    assert.equal((await fetch(runtime.base + '/api/resource/agent-origin?project=preview-project')).status, 422)
    assert.equal((await fetch(runtime.base + '/api/resource/agent-origin?path=readme.md')).status, 422)
    await runtime.request('/__preview/reset', 'provenance', { scene: 'empty' })
    const empty = await fetch(runtime.base + '/api/resource/agent-origin?project=current&path=readme.md')
    assert.equal(empty.status, 400)
    assert.deepEqual(await empty.json(), { detail: 'no_project_selected' })
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; runtime.close() }
})

test('real version-history and comparison consumers freeze two revisions of the same reviewed VFS file', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'versions-ui' } })
  try {
    await runtime.request('/__preview/reset', 'versions-ui', { scene: 'viewer-version_diff-states', pageId: 'viewer-version_diff' })
    const capability = await fetchVersionCapability('preview-project', 'readme.md')
    assert.ok(capability?.file_id && capability.version_id)
    assert.equal(capability.can_diff, true)
    const history = await fetchResourceVersions('preview-project', capability.file_id)
    assert.equal(history?.total, 2)
    const historical = history!.versions[1]
    const reference = { project: 'preview-project', fileId: capability.file_id, path: 'readme.md', historicalVersionId: historical.id, currentVersionId: capability.version_id, historicalSequence: historical.sequence, processor: null }
    assert.deepEqual(parseVersionDiffTab(versionDiffTab(reference).id), reference)
    const before = await fetchResourceVersionContent(reference.project, reference.historicalVersionId)
    const current = await fetchResourceVersionContent(reference.project, reference.currentVersionId)
    assert.deepEqual(before, new Uint8Array(readFileSync(new URL('../e2e/fixtures/data/minimal-project/readme.md', import.meta.url))))
    assert.deepEqual(current, new Uint8Array(readFileSync(new URL('./fixtures/readme.modified.md', import.meta.url))))
    const opened = await loadDocument({ kind: 'project', project: reference.project, path: reference.path })
    assert.ok('bytes' in opened)
    assert.deepEqual(opened.bytes, current)
    assert.equal(opened.revision, capability.disk_revision)
    assert.equal(opened.versioning?.version_id, reference.currentVersionId)
    const url = `/api/resource/versions/${historical.id}/content?project=preview-project`
    const head = await fetch(runtime.base + url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(before!.byteLength))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    for (const [range, expected] of [['bytes=0-7', before!.slice(0, 8)], ['bytes=-5', before!.slice(-5)], ['bytes=8-', before!.slice(8)]] as const) {
      const response = await fetch(runtime.base + url, { headers: { range } })
      assert.equal(response.status, 206)
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected)
    }
    for (const range of ['bytes=999999-', 'bytes=0-1,3-4', 'bad', 'bytes=-0']) {
      const invalid = await fetch(runtime.base + url, { headers: { range } })
      assert.equal(invalid.status, 416)
      assert.equal(invalid.headers.get('content-range'), `bytes */${before!.length}`)
    }
    const oldId = capability.version_id
    await runtime.request('/__preview/reset', 'versions-ui', { scene: 'page-home' })
    assert.equal(await fetchResourceVersionContent('preview-project', oldId), null)
    assert.equal((await fetchResourceVersions('preview-project', (await fetchVersionCapability('preview-project', 'readme.md'))!.file_id!))!.total, 1)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; runtime.close() }
})

test('real snapshot sealing preserves revision fences, replay receipts and project isolation', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': 'versions-save' } })
  try {
    const original = (await fetchVersionCapability('preview-project', 'readme.md'))!
    assert.ok(original?.file_id)
    const response = await fetch(runtime.base + '/api/workbench/content?project=preview-project&path=readme.md', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'if-match': original.disk_revision! }, body: '# Saved version through real HTTP' })
    assert.equal(response.status, 204)
    const pending = (await fetchVersionCapability('preview-project', 'readme.md'))!
    assert.equal(pending.snapshot_state, 'pending')
    assert.equal(pending.drifted, false)
    assert.deepEqual(await sealResourceSnapshot('preview-project', 'readme.md', pending, 'real-consumer-key'), { ok: true })
    assert.deepEqual(await sealResourceSnapshot('preview-project', 'readme.md', pending, 'real-consumer-key'), { ok: true })
    assert.deepEqual(await sealResourceSnapshot('preview-project', 'readme.md', original, 'stale-key'), { ok: false, error: 'revision_conflict' })
    assert.equal((await fetchResourceVersions('preview-project', pending.file_id!))!.total, 2)
    const current = (await fetchVersionCapability('preview-project', 'readme.md'))!
    const unknown = await fetch(runtime.base + '/api/resource/versions/unknown/content?project=preview-project')
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).error.code, 'version_not_found')
    assert.equal((await originalFetch(runtime.base + `/api/resource/versions/${current.version_id}/content?project=preview-project`, { headers: { 'x-preview-instance': 'other' } })).status, 404)
    assert.equal((await fetch(runtime.base + `/api/resource/versions/${current.version_id}/restore?project=preview-project`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 501)
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; runtime.close() }
})

test('components declare their exact sample session while project trash and artifact libraries expose owned empty DTOs', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  let selected = 'gallery'
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': selected } })
  try {
    assert.equal((await runtime.request('/__preview/reset', selected, { scene: 'components-states', pageId: 'development-components' })).status, 200)
    assert.deepEqual(await listQueuedMessages('composer-preview'), [])
    assert.equal((await getAssistantContext('composer-preview'))?.session_id, 'composer-preview')
    assert.deepEqual(await listAnswerAnnotations('composer-preview'), [])
    assert.deepEqual(await listArtifactLibraryLinks('composer-preview'), { ok: true, links: [] })
    for (const action of ['model', 'mode']) assert.equal((await runtime.request(`/api/serve/sessions/composer-preview/${action}`, selected)).status, 200)
    for (const action of ['context', 'annotations', 'resources/links', 'literature/links']) assert.equal((await runtime.request(`/api/assistant/sessions/composer-preview/${action}`, selected)).status, 200)
    assert.equal((await runtime.request('/api/serve/sessions/not-a-session/model', selected)).status, 404)
    selected = 'ordinary'
    assert.equal((await runtime.request('/api/serve/sessions/composer-preview/model', selected)).status, 404)
    assert.deepEqual(await listArtifactLibraryLinks('preview-session'), { ok: true, links: [] })
    assert.deepEqual(await listArtifactLibraryLinks('not-a-session'), { ok: false, error: 'http_404' })
    assert.deepEqual(await loadTrashHistory('preview-project'), [])
    const trash = await runtime.request('/api/content/trash?project=preview-project&limit=1', selected)
    assert.deepEqual(trash.body, { project_id: 'preview-project', entries: [] })
    assert.equal((await runtime.request('/api/content/trash?project=unknown', selected)).status, 400)
    for (const limit of ['0', '201', 'abc']) assert.equal((await runtime.request(`/api/content/trash?limit=${limit}`, selected)).status, 422)
    selected = 'empty-gallery'
    await runtime.request('/__preview/reset', selected, { scene: 'empty' })
    assert.equal((await runtime.request('/api/content/trash', selected)).body.detail, 'no_project_selected')
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; runtime.close() }
})

test('real feedback multipart consumer produces isolated receipts without retaining text, attachments or collecting logs', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  let instance = 'feedback-first'
  try {
    const client = await feedbackClient(runtime, () => instance)
    globalThis.window = { scholarseed: client.bridge } as unknown as Window & typeof globalThis
    const unique = 'private feedback body never retained'
    const submitted = await submitFeedback({ description: unique, email: 'private@example.invalid', includeLogs: true, includeTrace: true, sessionId: 'preview-session', images: [new File(['image payload'], 'private-image.png', { type: 'image/png' })], recordingReport: new File(['{"schemaVersion":1}'], 'recording.json', { type: 'application/json' }), rendererDiagnostics: new File(['{"schemaVersion":1}'], 'diagnostics.json', { type: 'application/json' }) })
    assert.equal(submitted.ok, true)
    assert.equal(client.responses[0].status, 200)
    assert.match(submitted.id!, /^preview-feedback:/)
    const state = await runtime.request('/__preview/state', instance)
    assert.equal(state.body.feedback.receipts.length, 1)
    assert.equal(state.body.feedback.receipts[0].id, submitted.id)
    assert.equal(state.body.feedback.receipts[0].imageCount, 1)
    assert.equal(state.body.feedback.receipts[0].imageBytes, 13)
    assert.equal(state.body.feedback.receipts[0].collectedLogs, false)
    assert.equal(state.body.feedback.receipts[0].collectedTrace, false)
    for (const secret of [unique, 'private@example.invalid', 'image payload', 'private-image.png']) assert.ok(!JSON.stringify(state.body).includes(secret))
    instance = 'feedback-second'
    assert.equal((await runtime.request('/__preview/state', instance)).body.feedback.receipts.length, 0)
    instance = 'feedback-first'
    await runtime.request('/__preview/reset', instance, { scene: 'page-home' })
    assert.equal((await runtime.request('/__preview/state', instance)).body.feedback.receipts.length, 0)
    const afterReset = await submitFeedback({ description: 'After reset' })
    assert.equal(afterReset.ok, true)
    assert.notEqual(afterReset.id, submitted.id)
  } finally { globalThis.window = originalWindow; runtime.close() }
})

test('feedback validates multipart description, image bounds and report schema before issuing any receipt', async () => {
  const runtime = await fixture()
  const send = async (description: string, attachments: (form: FormData) => void = () => {}) => {
    const form = new FormData()
    form.set('description', description)
    attachments(form)
    const response = await fetch(runtime.base + '/api/serve/feedback', { method: 'POST', headers: { 'x-preview-instance': 'feedback-validation' }, body: form })
    return { status: response.status, body: await response.json() }
  }
  try {
    assert.deepEqual(await send('   '), { status: 422, body: { detail: 'description is required' } })
    assert.deepEqual(await send('x'.repeat(5001)), { status: 422, body: { detail: 'description exceeds 5000 characters' } })
    assert.equal((await send('Image count', form => { for (let index = 0; index < 6; index++) form.append('images', new File([], 'empty.png')) })).body.detail, 'at most 5 images')
    assert.equal((await send('Image size', form => form.append('images', new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png')))).body.detail, 'image large.png exceeds 20MB')
    assert.equal((await send('Images total', form => { for (let index = 0; index < 3; index++) form.append('images', new File([new Uint8Array(14 * 1024 * 1024)], `image-${index}.png`)) })).body.detail, 'images exceed 40MB in total')
    for (const field of ['recording_report', 'renderer_diagnostics']) {
      assert.equal((await send('Report MIME', form => form.append(field, new File(['{}'], 'report.txt', { type: 'text/plain' })))).status, 422)
      assert.equal((await send('Report JSON', form => form.append(field, new File(['not json'], 'report.json', { type: 'application/json' })))).status, 422)
      assert.equal((await send('Report schema', form => form.append(field, new File(['{"schemaVersion":2}'], 'report.json', { type: 'application/json' })))).status, 422)
      assert.equal((await send('Report size', form => form.append(field, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'report.json', { type: 'application/json' })))).status, 422)
    }
    assert.equal((await send('Bad boolean', form => form.set('include_logs', 'maybe'))).status, 422)
    const malformed = await fetch(runtime.base + '/api/serve/feedback', { method: 'POST', headers: { 'x-preview-instance': 'feedback-validation', 'content-type': 'multipart/form-data; boundary=missing' }, body: 'broken body' })
    assert.equal(malformed.status, 422)
    assert.equal((await runtime.request('/__preview/state', 'feedback-validation')).body.feedback.receipts.length, 0)
    assert.equal((await send('Empty attachment skipped', form => form.append('images', new File([], 'empty.png')))).status, 200)
    assert.equal((await send('😀'.repeat(5000))).status, 200)
    assert.equal((await send('Excessive multipart body', form => form.append('images', new File([new Uint8Array(45 * 1024 * 1024 + 1)], 'excessive.png')))).status, 413)
  } finally { runtime.close() }
})

test('declared feedback failure and rate-limit scenes reach the real consumer without issuing receipts', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  try {
    const client = await feedbackClient(runtime, () => 'feedback-policy')
    globalThis.window = { scholarseed: client.bridge } as unknown as Window & typeof globalThis
    for (const [scene, limited, error] of [['feedback-failed', false, 'feedback upstream unavailable'], ['feedback-rate-limited', true, 'feedback rate limited']] as const) {
      assert.equal((await runtime.request('/__preview/reset', 'feedback-policy', { scene, pageId: 'surface-feedback' })).status, 200)
      const rejected = await submitFeedback({ description: 'A valid report in the selected scene' })
      assert.deepEqual(rejected, { ok: false, code: 'failed', rateLimited: limited })
      assert.deepEqual(client.responses.at(-1), { status: limited ? 429 : 502, body: { detail: error } })
      assert.equal((await runtime.request('/__preview/state', 'feedback-policy')).body.feedback.receipts.length, 0)
    }
    await runtime.request('/__preview/reset', 'feedback-policy', { scene: 'feedback-normal', pageId: 'surface-feedback' })
    assert.equal((await submitFeedback({ description: 'Back to normal' })).ok, true)
    assert.equal(client.responses.at(-1)?.status, 200)
  } finally { globalThis.window = originalWindow; runtime.close() }
})

test('resource reveal resolves existing virtual nodes through the real document location consumer without native access', async () => {
  const runtime = await fixture()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('referer') && !headers.has('x-preview-instance')) headers.set('x-preview-instance', 'first')
    return originalFetch(input, { ...init, headers })
  }
  try {
    for (const path of ['sample.docx', 'sample.xls']) {
      assert.deepEqual(await resolveDocumentLocation({ kind: 'project', project: 'preview-project', path }), { ok: true, absolute: `/preview/workspace/design/${path}` })
    }
    const createdNode = await runtime.request('/api/resource/node', 'first', { project: 'preview-project', action: 'create_document', parent: 'notes', name: 'note.md' })
    assert.equal(createdNode.status, 200)
    const directory = await runtime.request('/api/resource/reveal', 'first', { project: 'preview-project', path: 'notes' })
    assert.deepEqual(directory.body, { absolute: '/preview/workspace/design/notes' })
    const root = await runtime.request('/api/resource/reveal', 'first', { project: 'preview-project', path: '' })
    assert.deepEqual(root.body, { absolute: '/preview/workspace/design' })
    const state = await runtime.request('/__preview/state')
    const bridge = createPreviewBridge({ instance: 'first', scene: 'page-home', preferences: state.body.preferences, request: originalFetch })
    const native = await bridge.revealPath(directory.body.absolute)
    assert.equal(native.ok, false)
    assert.deepEqual((native as { applicationFailure?: unknown }).applicationFailure, { code: 'desktop_bridge_unavailable' })
    const missing = await resolveDocumentLocation({ kind: 'project', project: 'preview-project', path: 'missing.xls' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'node_not_found')
    for (const path of ['../sample.xls', '/Users/private/data.xls', 'C:\\Users\\private.xls', '\\\\server\\share', 'bad\0path']) {
      const rejected = await runtime.request('/api/resource/reveal', 'first', { project: 'preview-project', path })
      assert.equal(rejected.status, 400, path)
      assert.equal(rejected.body.absolute, undefined)
    }
    assert.equal((await runtime.request('/api/resource/reveal', 'first', { project: 'preview-project', path: 12 })).status, 400)
    const created = await createProject(runtime, 'Private instance project')
    assert.equal((await runtime.request('/api/resource/reveal', 'second', { project: created.id, path: '' })).status, 404)
    assert.equal((await runtime.request('/api/resource/reveal', 'first', { project: 'not-a-project', path: 'sample.xls' })).status, 404)
    assert.equal((await runtime.request('/api/resource/reveal?project=not-a-project', 'first', { project: 'preview-project', path: 'sample.xls' })).status, 200)
    const method = await originalFetch(runtime.base + '/api/resource/reveal', { headers: { 'x-preview-instance': 'first' } })
    assert.equal(method.status, 501)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    runtime.close()
  }
})

test('reviewed viewer formats expose actual bytes and honest capabilities through workbench', async () => {
  const runtime = await fixture()
  try {
    for (const document of PREVIEW_DOCUMENTS) {
      const query = new URLSearchParams({ project: 'preview-project', path: document.path })
      const opened = await runtime.request(`/api/workbench/open?${query}`)
      assert.equal(opened.status, 200)
      assert.equal(opened.body.viewer, document.viewer, document.path)
      assert.equal(opened.body.processor, document.processor, document.path)
      assert.equal(opened.body.media_type, document.mediaType)
      assert.equal(opened.body.capabilities.can_edit, document.editable)
      assert.equal(opened.body.capabilities.can_save, document.editable)
      assert.equal(opened.body.capabilities.can_select, document.selectable)
      const content = await fetch(runtime.base + opened.body.content_url, { headers: { 'x-preview-instance': 'first' } })
      const bytes = new Uint8Array(await content.arrayBuffer())
      assert.equal(content.status, 200)
      assert.equal(bytes.length, opened.body.size)
      assert.equal(opened.body.revision, `sha256:${document.sha256}`)
      if (document.path === 'sample.png') {
        assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        const dimensions = new DataView(bytes.buffer, bytes.byteOffset)
        assert.equal(dimensions.getUint32(16), 200)
        assert.equal(dimensions.getUint32(20), 200)
      }
      if (document.path === 'sample.docx') assert.deepEqual([...bytes.slice(0, 2)], [80, 75])
      if (document.path === 'sample.xls') assert.deepEqual([...bytes.slice(0, 4)], [208, 207, 17, 224])
      if (document.path === 'sample.bin') {
        assert.equal(opened.body.content_kind, 'binary')
        assert.equal(opened.body.capabilities.can_preview, false)
        assert.ok(bytes.includes(0))
      }
      if (!document.editable) {
        const rejected = await fetch(runtime.base + opened.body.content_url, { method: 'PUT', headers: { 'x-preview-instance': 'first', 'content-type': 'application/octet-stream', 'if-match': opened.body.revision }, body: 'not saved' })
        assert.equal(rejected.status, 403)
      }
    }
    const query = '/api/workbench/content?project=preview-project&path=measurements.csv'
    const original = await runtime.request('/api/workbench/open?project=preview-project&path=measurements.csv')
    const saved = await fetch(runtime.base + query, { method: 'PUT', headers: { 'x-preview-instance': 'first', 'content-type': 'application/octet-stream', 'if-match': original.body.revision }, body: 'Label,Value\nSaved row,42\n' })
    assert.equal(saved.status, 204)
    const reopened = await runtime.request('/api/workbench/open?project=preview-project&path=measurements.csv')
    assert.notEqual(reopened.body.revision, original.body.revision)
    assert.equal((await runtime.request('/api/resource/read?project=preview-project&path=measurements.csv')).body.content, 'Label,Value\nSaved row,42\n')
    assert.equal((await runtime.request(query + '&preview=true')).status, 501)
  } finally { runtime.close() }
})

async function waitPreviewSession(runtime: Awaited<ReturnType<typeof fixture>>, instance: string, session: string, status: string, timeoutMs = CONVERSATION_STATE_TIMEOUT_MS) {
  const started = performance.now()
  do {
    const snapshot = (await runtime.request('/api/serve/sessions/open', instance, { resume_session_id: session })).body
    if (snapshot.last_turn_status === status && snapshot.running === false) return snapshot
    assert.ok(performance.now() - started < timeoutMs, `Expected session status ${status}`)
    await new Promise(resolve => setTimeout(resolve, CONVERSATION_POLL_MS))
  } while (performance.now() - started < timeoutMs)
  assert.fail(`Expected session status ${status}`)
}

async function faultPreviewSession(runtime: Awaited<ReturnType<typeof fixture>>, instance: string) {
  const session = 'preview-session'
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await runtime.request('/__preview/reset', instance, { scene: 'conversation-recovery', pageId: 'page-conversation' })
    const stream = await fetch(`${runtime.base}/api/serve/sessions/${session}/events?from_seq=0&previewInstance=${instance}`, { signal: controller.signal })
    const closed = stream.text().then(text => ({ text, error: null }), error => ({ text: '', error }))
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '首轮失败' }] })
    await waitPreviewSession(runtime, instance, session, 'failed')
    await runtime.request(`/api/serve/sessions/${session}/turns`, instance, { input: [{ type: 'text', text: '原入口重试' }] })
    timer = setTimeout(() => controller.abort(), CONVERSATION_STREAM_CLOSE_TIMEOUT_MS)
    const prefix = await closed
    assert.equal(prefix.error, null, 'the service must close its actual HTTP stream, not rely on a test abort')
    const frames = prefix.text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice('data: '.length)))
    return { session, frames }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}

test('runtime reconfiguration real clients read isolated idle state without admitting mutations', async () => {
  const runtime = await fixture()
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let instance = 'runtime-first'
  globalThis.window = { scholarseed: { getApiBase: () => runtime.base } } as unknown as Window & typeof globalThis
  globalThis.fetch = (input, init) => originalFetch(input, { ...init, headers: { ...init?.headers, 'x-preview-instance': instance } })
  try {
    for (instance of ['runtime-first', 'runtime-second']) {
      await runtime.request('/__preview/reset', instance, { scene: 'home-open-task', pageId: 'page-home' })
      const sessions = await runtime.request('/api/serve/sessions', instance)
      const session = sessions.body.sessions[0].session_id
      assert.deepEqual(await getSharedRuntimeReconfiguration(), { state: null, service_instance_id: `preview-${instance}` })
      assert.equal(await currentRuntimeReconfiguration(session), undefined)
      await assert.rejects(currentRuntimeReconfiguration('not-a-preview-session'), /runtime_reconfiguration_unknown/)
      const mutation = await runtime.request(`/api/serve/sessions/${session}/runtime/reconfigure`, instance, { request_id: 'not-authorized' })
      assert.equal(mutation.status, 501)
      assert.deepEqual(await getSharedRuntimeReconfiguration(), { state: null, service_instance_id: `preview-${instance}` })
    }
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; runtime.close() }
})

async function fixture() {
  const service = createPreviewService()
  const server = createServer((request, response) => service.middleware(request, response, () => {
    response.writeHead(404).end()
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  return {
    base,
    server,
    async request(path: string, instance = 'first', body?: unknown) {
      const response = await fetch(base + path, {
        headers: { referer: `${base}/?previewInstance=${instance}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
    },
    close() { service.dispose(); server.closeAllConnections(); server.close() },
  }
}

async function feedbackClient(runtime: Awaited<ReturnType<typeof fixture>>, instance: () => string) {
  const state = await runtime.request('/__preview/state', instance())
  const responses: { status: number; body: unknown }[] = []
  const bridge = createPreviewBridge({
    instance: instance(),
    scene: 'page-home',
    preferences: state.body.preferences,
    request: async (input, init) => {
      assert.ok(typeof input === 'string')
      assert.equal(input, '/api/serve/feedback')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.credentials, 'omit')
      const headers = new Headers(init?.headers)
      headers.set('x-preview-instance', instance())
      const response = await fetch(new URL(input, runtime.base), { ...init, headers })
      responses.push({ status: response.status, body: await response.clone().json() })
      return response
    },
  })
  return { bridge, responses }
}

async function createProject(runtime: Awaited<ReturnType<typeof fixture>>, name: string, instance = 'first') {
  const accepted = await runtime.request('/api/content/projects', instance, { name })
  assert.equal(accepted.status, 202)
  assert.match(accepted.body.operation, /^[a-f0-9]{32}$/)
  return waitForProjectOperation(runtime, accepted.body.operation, instance)
}

async function waitForProjectOperation(runtime: Awaited<ReturnType<typeof fixture>>, identity: string, instance: string) {
  const deadline = Date.now() + PROJECT_TEST_TIMEOUT_MS
  while (Date.now() < deadline) {
    const operation = await runtime.request(`/api/content/operations/${identity}`, instance)
    assert.equal(operation.status, 200)
    if (operation.body.state === 'succeeded') return operation.body.result
    if (operation.body.state === 'failed') assert.fail(operation.body.error)
    await new Promise(resolve => setTimeout(resolve, PROJECT_POLL_INTERVAL_MS))
  }
  assert.fail('Preview project operation did not complete')
}

test('instances isolate projects, settings, resets and unknown requests fail closed', async () => {
  const runtime = await fixture()
  try {
    await createProject(runtime, 'Only first')
    const first = await runtime.request('/api/content/projects')
    const second = await runtime.request('/api/content/projects', 'second')
    assert.equal(first.body.projects.length, second.body.projects.length + 1)
    await runtime.request('/api/serve/settings/workflow', 'first', { enabled: false })
    assert.equal((await runtime.request('/api/serve/settings/workflow', 'second')).body.enabled, true)
    await runtime.request('/__preview/reset', 'first', { scene: 'chat' })
    assert.equal((await runtime.request('/api/content/projects')).body.projects.length, second.body.projects.length)
    const unknown = await runtime.request('/api/not-implemented')
    assert.equal(unknown.status, 501)
    assert.equal(unknown.body.code, 'preview_unimplemented')
  } finally { runtime.close() }
})

test('HTTP history, open snapshot and SSE replay share one event ledger without executing twice', async () => {
  const runtime = await fixture()
  try {
    const opened = await runtime.request('/api/serve/sessions/open', 'first', {})
    const session = opened.body.session_id
    const receipt = await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input: [{ type: 'text', text: 'Hello' }], client_user_message_id: 'client-hello' })
    assert.equal(receipt.body.accepted, true)
    assert.equal(receipt.body.disposition, 'direct')
    assert.ok(receipt.body.turn_id)
    await new Promise(resolve => setTimeout(resolve, 180))
    const history = (await runtime.request(`/api/serve/history/${session}`)).body
    const resumed = (await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: session })).body
    assert.equal(resumed.running, false)
    assert.equal(resumed.last_turn_status, 'completed')
    assert.equal(history.turns.filter((turn: { kind: string }) => turn.kind === 'user').length, 1)
    const response = await fetch(`${runtime.base}/api/serve/sessions/${session}/events?from_seq=0&previewInstance=first`)
    const reader = response.body!.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    assert.match(chunk, /"type":"user_message"/)
    assert.match(chunk, /"type":"turn_completed"/)
    assert.equal(resumed.last_seq, history.activity_events.at(-1).seq)
    assert.equal((await runtime.request(`/api/serve/history/${session}`, 'second')).status, 404)
    const applied = await runtime.request(`/api/serve/sessions/${session}/queue/client-hello/reconcile`, 'first', {})
    assert.equal(applied.body.outcome, 'applied')
    const absent = await runtime.request(`/api/serve/sessions/${session}/queue/client-not-submitted/reconcile`, 'first', {})
    assert.equal(absent.body.outcome, 'not_applied')
    assert.deepEqual((await runtime.request(`/api/resource/finalizations?project=preview-project&session_id=${session}`)).body, { entries: [], next_cursor: null })
  } finally { runtime.close() }
})

test('approval allow, deny, cancel and failure retry keep snapshots coherent', async () => {
  const runtime = await fixture()
  try {
    for (const choice of ['allow_once', 'deny', 'cancel']) {
      await runtime.request('/__preview/reset', 'first', { scene: 'approval' })
      const session = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
      await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input: [{ type: 'text', text: 'Review' }] })
      await new Promise(resolve => setTimeout(resolve, 100))
      const waiting = (await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: session })).body
      assert.equal(waiting.running, true)
      assert.equal(waiting.pending_hil.length, 1)
      const requestId = waiting.pending_hil[0].request_id
      await runtime.request(`/api/serve/sessions/${session}/hil/${requestId}`, 'first', choice === 'cancel' ? { cancelled: true } : { decision: choice })
      await new Promise(resolve => setTimeout(resolve, 100))
      const finished = (await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: session })).body
      assert.equal(finished.running, false)
      assert.equal(finished.pending_hil.length, 0)
      assert.equal(finished.last_turn_status, choice === 'cancel' ? 'interrupted' : 'completed')
    }
    await runtime.request('/__preview/reset', 'first', { scene: 'failure' })
    const session = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
    await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input: [{ type: 'text', text: 'Fail then retry' }] })
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.equal((await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: session })).body.last_turn_status, 'failed')
    await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input: [{ type: 'text', text: 'Retry' }] })
    await new Promise(resolve => setTimeout(resolve, 180))
    assert.equal((await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: session })).body.last_turn_status, 'completed')
  } finally { runtime.close() }
})

test('catalog navigation seeds once, saves preferences and resets only the chosen instance', async () => {
  const runtime = await fixture()
  try {
    const initial = await runtime.request('/__preview/state?scene=conversation-stream')
    assert.equal(initial.body.preferences.lastLocation.view, 'conversation')
    assert.equal(initial.body.preferences.lastLocation.sessionId, 'preview-session')
    const projectSessions = await runtime.request('/api/serve/sessions?scope=project&project_path=%2Fpreview%2Fworkspace%2Fdesign')
    assert.equal(projectSessions.body.sessions.length, 1)
    assert.equal(projectSessions.body.sessions[0].project_path, '/preview/workspace/design')
    const preferences = { ...initial.body.preferences, theme: 'dark' }
    await runtime.request('/__preview/state', 'first', { preferences })
    assert.equal((await runtime.request('/__preview/state?scene=page-home')).body.preferences.theme, 'dark')
    const reset = await runtime.request('/__preview/reset', 'first', { scene: 'settings-notifications-states', pageId: 'settings-notifications' })
    assert.equal(reset.body.preferences.lastLocation.settingsPage, 'notifications')
    const hidden = await runtime.request('/__preview/reset', 'first', { scene: 'settings-preferences-states', pageId: 'settings-preferences' })
    assert.equal(hidden.status, 200)
    assert.equal(hidden.body.preferences.lastLocation, null)
    const viewer = await runtime.request('/__preview/state?scene=viewer-browser', 'direct-viewer')
    assert.equal(viewer.status, 200)
    assert.equal(viewer.body.preferences.lastLocation, null)
    const browser = await runtime.request('/__preview/browser/snapshot', 'direct-viewer', {})
    assert.equal(browser.status, 200)
    assert.deepEqual(browser.body, { ok: true, snapshot: { tabs: [], activeTabId: null, automation: { enabled: false, port: null } } })
    assert.equal((await runtime.request('/__preview/state?scene=not-a-scene', 'invalid-scene')).status, 400)
    const resource = await runtime.request('/__preview/reset', 'first', { scene: 'resource-states', pageId: 'page-resource' })
    assert.equal(resource.body.preferences.lastLocation.projectId, 'preview-project')
    assert.equal((await runtime.request('/__preview/reset', 'first', { scene: 'not-a-scene' })).status, 400)
    assert.equal((await runtime.request('/__preview/state', '../escape')).status, 400)
  } finally { runtime.close() }
})

test('live SSE observes tool events and interruption cancels future increments', async () => {
  const runtime = await fixture()
  try {
    await runtime.request('/__preview/reset', 'first', { scene: 'tools' })
    const session = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
    const response = await fetch(`${runtime.base}/api/serve/sessions/${session}/events`, {
      headers: { 'x-preview-instance': 'first' },
    })
    const reader = response.body!.getReader()
    await reader.read()
    await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input: [{ type: 'text', text: 'Use tool' }] })
    let events = ''
    while (!events.includes('turn_completed')) events += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    assert.match(events, /tool_started/)
    assert.match(events, /tool_completed/)
    await runtime.request('/__preview/reset', 'first', { scene: 'streaming' })
    const active = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
    await runtime.request(`/api/serve/sessions/${active}/turns`, 'first', { input: [{ type: 'text', text: 'Cancel' }] })
    await runtime.request(`/api/serve/sessions/${active}/interrupt`, 'first', {})
    await new Promise(resolve => setTimeout(resolve, 180))
    const history = (await runtime.request(`/api/serve/history/${active}`)).body
    assert.equal(history.activity_events.filter((event: { type: string }) => event.type === 'message_delta').length, 0)
    assert.equal(history.turn_activity.at(-1).outcome, 'interrupted')
  } finally { runtime.close() }
})

test('reviewed VFS bytes open in real viewer DTOs, save with If-Match, rename and reset without cross-instance writes', async () => {
  const runtime = await fixture()
  try {
    const headers = { 'x-preview-instance': 'first' }
    const tree = await runtime.request('/api/resource/tree?project=preview-project')
    assert.deepEqual(tree.body.nodes.map((node: { path: string }) => node.path).sort(), PREVIEW_DOCUMENTS.map(document => document.path).sort())
    const opened = await runtime.request('/api/workbench/open?project=preview-project&path=readme.md')
    assert.equal(opened.body.viewer, 'markdown')
    assert.equal(opened.body.capabilities.can_save, true)
    const path = '/api/workbench/content?project=preview-project&path=readme.md'
    const before = await fetch(runtime.base + path, { headers })
    const original = await before.text()
    const revision = before.headers.get('etag')!
    const incorrectType = await fetch(runtime.base + path, { method: 'PUT', headers: { ...headers, 'if-match': revision }, body: '# Wrong content type\n' })
    assert.equal(incorrectType.status, 415)
    const missingRevision = await fetch(runtime.base + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: '# No revision\n' })
    assert.equal(missingRevision.status, 428)
    const save = await fetch(runtime.base + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'if-match': revision }, body: '# Edited preview\n' })
    assert.equal(save.status, 204)
    assert.notEqual(save.headers.get('etag'), revision)
    assert.equal((await fetch(runtime.base + path, { headers })).status, 200)
    const stale = await fetch(runtime.base + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'if-match': revision }, body: 'Overwrite stale' })
    assert.equal(stale.status, 412)
    assert.equal(await (await fetch(runtime.base + path, { headers: { 'x-preview-instance': 'second' } })).text(), original)
    const pdf = await fetch(runtime.base + '/api/workbench/content?project=preview-project&path=sample.pdf', { headers })
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.equal(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5)), '%PDF-')
    const renamed = await runtime.request('/api/resource/node', 'first', { action: 'rename', project: 'preview-project', path: 'readme.md', name: 'renamed.md' })
    assert.equal(renamed.body.node.path, 'renamed.md')
    assert.equal((await runtime.request('/api/workbench/open?project=preview-project&path=readme.md')).status, 404)
    assert.equal((await runtime.request('/api/workbench/open?project=preview-project&path=../secret')).status, 400)
    await runtime.request('/__preview/reset', 'first', { scene: 'chat' })
    assert.equal(await (await fetch(runtime.base + path, { headers })).text(), original)
  } finally { runtime.close() }
})

test('pin and archive use production PUT methods and return the session identity with boolean state', async () => {
  const runtime = await fixture()
  try {
    for (const action of ['pin', 'archive']) {
      const field = action === 'pin' ? 'pinned' : 'archived'
      const response = await fetch(`${runtime.base}/api/serve/sessions/preview-session/${action}`, {
        method: 'PUT', headers: { 'x-preview-instance': 'first', 'content-type': 'application/json' }, body: JSON.stringify({ [field]: true }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true, session_id: 'preview-session', [field]: true })
    }
  } finally { runtime.close() }
})

test('recovery retains each already streamed fragment and cancelled approval cannot be replayed', async () => {
  const runtime = await fixture()
  try {
    await runtime.request('/__preview/reset', 'first', { scene: 'streaming' })
    const session = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
    const response = await fetch(`${runtime.base}/api/serve/sessions/${session}/events?previewInstance=first`)
    const reader = response.body!.getReader()
    await reader.read()
    await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input: [{ type: 'text', text: 'Stream and restore' }] })
    let delivered = ''
    while (!delivered.includes('message_delta')) delivered += new TextDecoder().decode((await reader.read()).value)
    await runtime.request(`/api/serve/sessions/${session}/interrupt`, 'first', {})
    await reader.cancel()
    const history = (await runtime.request(`/api/serve/history/${session}`)).body
    const deltas = history.activity_events.filter((event: { type: string }) => event.type === 'message_delta')
    const projected = deltas.at(-1)?.data.delta ?? ''
    assert.equal(history.turns.find((turn: { kind: string }) => turn.kind === 'text').text, projected)
    assert.ok(projected.length > 0)
    const resumed = (await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: session })).body
    assert.equal(resumed.last_seq, history.activity_events.at(-1).seq)
    assert.equal(resumed.running, false)
    await runtime.request('/__preview/reset', 'first', { scene: 'approval' })
    const approving = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
    await runtime.request(`/api/serve/sessions/${approving}/turns`, 'first', { input: [{ type: 'text', text: 'Approval' }] })
    await new Promise(resolve => setTimeout(resolve, 100))
    const waiting = (await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: approving })).body
    await runtime.request(`/api/serve/sessions/${approving}/interrupt`, 'first', {})
    const stale = await runtime.request(`/api/serve/sessions/${approving}/hil/${waiting.pending_hil[0].request_id}`, 'first', { option_id: 'y' })
    assert.equal(stale.status, 409)
    assert.equal((await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: approving })).body.last_turn_status, 'interrupted')
  } finally { runtime.close() }
})

test('direct admission closes the same Composer outbox identity after completed and interrupted turns', async () => {
  const runtime = await fixture()
  try {
    for (const outcome of ['completed', 'interrupted']) {
      await runtime.request('/__preview/reset', 'first', { scene: 'streaming' })
      const session = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
      const messageId = `outbox-${outcome}`
      const input = [{ type: 'text' as const, text: outcome }]
      const optimistic = optimisticQueuedMessage([], messageId, input, [], undefined, 'direct')
      const receipt = (await runtime.request(`/api/serve/sessions/${session}/turns`, 'first', { input, client_user_message_id: messageId })).body
      const accepted = settleOptimisticQueuedMessage([optimistic], messageId, receipt.disposition)
      assert.equal(hasAcceptedMessageAwaitingRuntime(accepted), true)
      if (outcome === 'interrupted') await runtime.request(`/api/serve/sessions/${session}/interrupt`, 'first', {})
      await new Promise(resolve => setTimeout(resolve, 180))
      const history = (await runtime.request(`/api/serve/history/${session}`)).body
      const removed = history.activity_events.filter((event: { type: string; data: { queued_message_id?: string } }) => event.type === 'message_removed' && event.data.queued_message_id === messageId)
      assert.equal(removed.length, 1)
      const remaining = accepted.filter(message => !removed.some((event: { data: { queued_message_id: string } }) => event.data.queued_message_id === message.queuedMessageId))
      assert.equal(hasAcceptedMessageAwaitingRuntime(remaining), false)
    }
  } finally { runtime.close() }
})

test('project explorer and PDF record snapshots resolve the same reviewed VFS identities', async () => {
  const runtime = await fixture()
  try {
    const treePath = '/api/content/projects/preview-project/tree?path=&offset=0'
    const tree = await runtime.request(treePath)
    assert.equal(tree.status, 200)
    assert.equal(tree.body.root, '/preview/workspace/design')
    assert.equal(tree.body.total, PREVIEW_DOCUMENTS.length)
    assert.ok(tree.body.nodes.every((node: { available: boolean }) => node.available))
    const projection = (await runtime.request('/api/workbench/open?project=preview-project&path=sample.pdf')).body
    const recordPath = `/api/workbench/assets/${encodeURIComponent(projection.asset_id)}/pdf/records?project=preview-project`
    const records = await runtime.request(recordPath)
    assert.equal(records.status, 200)
    assert.equal(records.body.record_target.owner, 'project_asset')
    assert.equal(records.body.record_target.subject_id, projection.asset_id)
    assert.equal(records.body.source_revision, projection.revision)
    assert.equal(records.body.source_state, 'available')
    assert.equal(records.body.source_path, 'sample.pdf')
    assert.deepEqual(records.body.records, { schema_version: 1, marks: [], comments: [], notes: [] })
    assert.match(records.body.record_revision, /^sha256:[a-f0-9]{64}$/)
    assert.equal((await runtime.request('/api/content/projects/not-owned/tree')).status, 404)
    assert.equal((await runtime.request('/api/workbench/assets/not-owned/pdf/records?project=preview-project')).status, 404)
    await runtime.request('/api/resource/node', 'first', { action: 'rename', project: 'preview-project', path: 'sample.pdf', name: 'renamed.pdf' })
    assert.equal((await runtime.request(recordPath)).body.source_path, 'renamed.pdf')
    assert.equal((await runtime.request(treePath)).body.nodes.some((node: { name: string }) => node.name === 'renamed.pdf'), true)
    assert.equal((await runtime.request(recordPath, 'second')).body.source_path, 'sample.pdf')
  } finally { runtime.close() }
})

test('external-root listing includes only the owned virtual project root and never grants host paths', async () => {
  const runtime = await fixture()
  try {
    const listing = await runtime.request('/api/content/roots?project=preview-project')
    assert.equal(listing.status, 200)
    assert.deepEqual(listing.body, { roots: [], writableRoots: ['/preview/workspace/design'] })
    const project = await createProject(runtime, 'Other virtual project')
    const other = await runtime.request(`/api/content/roots?project=${encodeURIComponent(project.id)}`)
    assert.deepEqual(other.body.writableRoots, [project.root])
    assert.notDeepEqual(other.body.writableRoots, listing.body.writableRoots)
    const external = await runtime.request('/api/content/roots?project=%2FUsers%2Fprivate-host-project')
    assert.equal(external.status, 404)
    assert.equal(JSON.stringify(external.body).includes('/Users/'), false)
    assert.equal((await runtime.request(`/api/content/roots?project=${encodeURIComponent(project.id)}`, 'second')).status, 404)
  } finally { runtime.close() }
})

test('an approval from a previous reset cannot resolve a new request in the reused seed session', async () => {
  const runtime = await fixture()
  try {
    const approvalPath = '/api/serve/sessions/preview-session'
    const pending = async () => (await runtime.request('/api/serve/sessions/open', 'first', { resume_session_id: 'preview-session' })).body.pending_hil
    await runtime.request('/__preview/reset', 'first', { scene: 'approval' })
    await runtime.request(`${approvalPath}/turns`, 'first', { input: [{ type: 'text', text: 'First approval' }] })
    await new Promise(resolve => setTimeout(resolve, 100))
    const oldId = (await pending())[0].request_id
    await runtime.request('/__preview/reset', 'first', { scene: 'approval' })
    await runtime.request(`${approvalPath}/turns`, 'first', { input: [{ type: 'text', text: 'New approval' }] })
    await new Promise(resolve => setTimeout(resolve, 100))
    const newId = (await pending())[0].request_id
    assert.notEqual(newId, oldId)
    const stale = await runtime.request(`${approvalPath}/hil/${encodeURIComponent(oldId)}`, 'first', { option_id: 'y' })
    assert.equal(stale.status, 409)
    assert.deepEqual((await pending()).map((item: { request_id: string }) => item.request_id), [newId])
  } finally { runtime.close() }
})

test('skill settings consume isolated typed inventory, documents, toggles and deletion without filesystem operations', async () => {
  const runtime = await fixture()
  try {
    const initial = await runtime.request('/api/capabilities/skills?surface=settings')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.skills.length, 3)
    const user = initial.body.skills.find((skill: { group: string; dependency_status: string }) => skill.group === 'user' && skill.dependency_status === 'ready')
    const builtin = initial.body.skills.find((skill: { group: string }) => skill.group === 'scholarseed')
    const document = await runtime.request(`/api/capabilities/skills/${user.name}/document`)
    assert.match(document.body.document, /模拟技能/)
    assert.ok(document.body.path.startsWith('/preview/'))
    const disabled = await fetch(`${runtime.base}/api/capabilities/skills/${user.name}/activate?previewInstance=first`, { method: 'DELETE' })
    assert.deepEqual(await disabled.json(), { name: user.name, active: false })
    const inventory = (await runtime.request('/api/capabilities/skills?surface=settings')).body
    assert.equal(inventory.skills.find((skill: { name: string }) => skill.name === user.name).enabled, false)
    assert.equal((await runtime.request('/api/capabilities/skills?surface=settings', 'second')).body.skills.find((skill: { name: string }) => skill.name === user.name).enabled, true)
    const immutable = await fetch(`${runtime.base}/api/capabilities/skills/${builtin.name}/activate?previewInstance=first`, { method: 'DELETE' })
    assert.equal(immutable.status, 409)
    assert.equal((await immutable.json()).detail.code, 'immutable_skill')
    const removed = await fetch(`${runtime.base}/api/capabilities/skills/${user.name}?previewInstance=first`, { method: 'DELETE' })
    assert.deepEqual(await removed.json(), { name: user.name, deleted: true })
    assert.equal((await runtime.request(`/api/capabilities/skills/${user.name}/document`)).status, 404)
    assert.equal((await runtime.request('/api/capabilities/skills?surface=unknown')).status, 422)
    const upload = new FormData()
    upload.append('file', new Blob(['# no installation']), 'preview.md')
    assert.equal((await fetch(`${runtime.base}/api/capabilities/skills/upload?previewInstance=first`, { method: 'POST', body: upload })).status, 501)
    await runtime.request('/__preview/reset', 'first', { scene: 'empty' })
    assert.deepEqual((await runtime.request('/api/capabilities/skills?surface=settings')).body.skills, [])
  } finally { runtime.close() }
})

test('document scenes seed the real owned project workspace open without changing ordinary layout defaults', async () => {
  const runtime = await fixture()
  try {
    for (const [kind, file] of [['markdown', 'readme.md'], ['code', 'hello.py'], ['pdf', 'sample.pdf']]) {
      const state = (await runtime.request('/__preview/reset', 'first', { scene: `viewer-${kind}-states`, pageId: `viewer-${kind}` })).body
      assert.equal(state.preferences.lastLocation.projectId, 'preview-project')
      assert.equal(state.preferences.lastLocation.target.kind, 'document')
      assert.deepEqual(state.preferences.lastLocation.target.source, { kind: 'project', project: 'preview-project', path: file })
      assert.deepEqual(state.preferences.projectLayouts['preview-project'], { ...DEFAULT_PROJECT_LAYOUT, open: true })
    }
    const home = (await runtime.request('/__preview/reset', 'first', { scene: 'page-home' })).body
    assert.equal(home.preferences.projectLayouts['preview-project']?.open ?? DEFAULT_PROJECT_LAYOUT.open, false)
  } finally { runtime.close() }
})

test('project creation exposes real 202 operation states and the renderer resolver polls without replaying mutation', async () => {
  const runtime = await fixture()
  const previousWindow = globalThis.window
  try {
    const directory = await runtime.request('/api/content/projects/directory?name=Async%20project', 'default')
    assert.equal(directory.status, 200)
    const before = (await runtime.request('/api/content/projects', 'default')).body.projects.length
    const accepted = await fetch(`${runtime.base}/api/content/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Async project' }) })
    assert.equal(accepted.status, 202)
    const submitted = await accepted.clone().json()
    assert.match(submitted.operation, /^[a-f0-9]{32}$/)
    assert.equal(submitted.state, 'queued')
    assert.equal((await runtime.request('/api/content/projects', 'default')).body.projects.length, before)
    assert.equal((await runtime.request(`/api/content/operations/${submitted.operation}`, 'other')).status, 404)
    Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => runtime.base } } })
    const resolved = await resolveContentResponse(accepted)
    assert.equal(resolved.status, 200)
    const project = await resolved.json()
    assert.equal(project.name, 'Async project')
    assert.equal(project.root, directory.body.root)
    assert.equal((await runtime.request('/api/content/projects', 'default')).body.projects.length, before + 1)
    assert.equal((await runtime.request('/api/content/projects', 'default')).body.projects[0].id, project.id)
    assert.deepEqual((await runtime.request(`/api/resource/tree?project=${project.id}`, 'default')).body.nodes, [])
    const patched = await fetch(`${runtime.base}/api/content/projects`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: project.id, name: 'Renamed project', description: 'Metadata only', pinned: true }) })
    assert.equal(patched.status, 200)
    const metadata = await patched.json()
    assert.equal(metadata.root, project.root)
    assert.equal(metadata.name, 'Renamed project')
    assert.equal(metadata.description, 'Metadata only')
    assert.equal(metadata.pinned, true)
    assert.equal((await runtime.request(`/api/content/operations/${submitted.operation}`, 'default')).body.state, 'succeeded')
    const diagnostics = (await runtime.request('/__preview/state', 'default')).body.diagnostics
    assert.equal(diagnostics.requests.filter((request: { method: string; path: string }) => request.method === 'POST' && request.path === '/api/content/projects').length, 1)
    assert.ok(diagnostics.requests.some((request: { method: string; path: string }) => request.method === 'GET' && request.path === `/api/content/operations/${submitted.operation}`))
  } finally { Object.assign(globalThis, { window: previousWindow }); runtime.close() }
})

test('failed and reset project operations never publish partial catalogs or surviving timers', async () => {
  const runtime = await fixture()
  const previousWindow = globalThis.window
  try {
    Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => runtime.base } } })
    const before = (await runtime.request('/api/content/projects', 'default')).body.projects
    for (const [name, error] of [['', 'name_required'], ['x'.repeat(PROJECT_NAME_MAX + 1), 'name_too_long']]) {
      const accepted = await fetch(`${runtime.base}/api/content/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
      assert.equal(accepted.status, 202)
      const failed = await resolveContentResponse(accepted)
      assert.equal(failed.status, 400)
      assert.deepEqual(await failed.json(), { detail: error })
      assert.deepEqual((await runtime.request('/api/content/projects', 'default')).body.projects, before)
    }
    const cancelled = await runtime.request('/api/content/projects', 'default', { name: 'Cancelled by reset' })
    await runtime.request('/__preview/reset', 'default', { scene: 'chat' })
    assert.equal((await runtime.request(`/api/content/operations/${cancelled.body.operation}`, 'default')).status, 404)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal((await runtime.request('/api/content/projects', 'default')).body.projects.some((project: { name: string }) => project.name === 'Cancelled by reset'), false)
    assert.equal((await runtime.request('/api/content/projects/adopt', 'default', { path: '/host/private', name: 'No host access' })).status, 501)
  } finally { Object.assign(globalThis, { window: previousWindow }); runtime.close() }
})

test('declared project failure policy fails one valid creation, preserves the directory plan and allows real retry', async () => {
  const runtime = await fixture()
  const previousWindow = globalThis.window
  try {
    await runtime.request('/__preview/reset', 'default', { scene: 'projects-create-failure', pageId: 'page-projects' })
    Object.assign(globalThis, { window: { scholarseed: { getApiBase: () => runtime.base } } })
    const before = (await runtime.request('/api/content/projects', 'default')).body.projects
    const directory = (await runtime.request('/api/content/projects/directory?name=Retry%20project', 'default')).body.root
    const submit = () => fetch(`${runtime.base}/api/content/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Retry project' }) })
    const failed = await resolveContentResponse(await submit())
    assert.equal(failed.status, 400)
    assert.deepEqual(await failed.json(), { detail: 'preview_project_creation_failed' })
    assert.deepEqual((await runtime.request('/api/content/projects', 'default')).body.projects, before)
    const succeeded = await resolveContentResponse(await submit())
    assert.equal(succeeded.status, 200)
    assert.equal((await succeeded.json()).root, directory)
    assert.equal((await runtime.request('/api/content/projects', 'default')).body.projects.length, before.length + 1)
  } finally { Object.assign(globalThis, { window: previousWindow }); runtime.close() }
})

test('disposing a project simulation cancels pending effects, not just the public operation lookup', async () => {
  const projects = new ProjectSimulation('/preview/dispose', [])
  const operation = projects.create('Must not appear')
  projects.dispose()
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.deepEqual(projects.all(), [])
  assert.throws(() => projects.operation(operation), /content_operation_unknown/)
})

test('service diagnostics use bounded request summaries and existing event ledgers without private content', async () => {
  const runtime = await fixture()
  try {
    const privateText = 'private diagnostic payload should never be summarized'
    const session = (await runtime.request('/api/serve/sessions/open', 'first', {})).body.session_id
    await runtime.request(`/api/serve/sessions/${session}/turns?token=private-query`, 'first', { input: [{ type: 'text', text: privateText }] })
    await runtime.request('/api/resource/write', 'first', { project: 'preview-project', path: 'diagnostic.md', content: privateText })
    await new Promise(resolve => setTimeout(resolve, 180))
    const first = (await runtime.request('/__preview/state')).body.diagnostics
    assert.ok(first.requests.some((request: { method: string; path: string; status: number }) => request.method === 'POST' && request.path === `/api/serve/sessions/${session}/turns` && request.status === 200))
    assert.ok(first.events.some((event: { type: string }) => event.type === 'turn_completed'))
    assert.ok(first.files.some((event: { path: string; kind: string }) => event.path === 'diagnostic.md' && event.kind === 'modified'))
    assert.equal(JSON.stringify(first).includes(privateText), false)
    assert.equal(JSON.stringify(first).includes('private-query'), false)
    assert.ok(first.requests.length <= PREVIEW_DIAGNOSTIC_LIMIT && first.events.length <= PREVIEW_DIAGNOSTIC_LIMIT && first.files.length <= PREVIEW_DIAGNOSTIC_LIMIT)
    assert.deepEqual((await runtime.request('/__preview/state', 'second')).body.diagnostics.events, [])
    await runtime.request('/__preview/reset', 'first', { scene: 'chat' })
    const reset = (await runtime.request('/__preview/state')).body.diagnostics
    assert.deepEqual(reset.events, [])
    assert.equal(reset.requests.some((request: { path: string }) => request.path.includes(session)), false)
  } finally { runtime.close() }
})
