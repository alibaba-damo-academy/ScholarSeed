import assert from 'node:assert/strict'
import test from 'node:test'
import {
  componentAction,
  componentCopy,
  componentCopyText,
  componentPlotExport,
  PLUGIN_MAX_PLOT_BYTES,
  createComponentGesture,
  componentRPC,
  componentDraft,
  componentRequest,
  componentHeight,
  PLUGIN_MESSAGE_CHANNEL,
  PLUGIN_MAX_FRAME_HEIGHT,
  PLUGIN_GESTURE_TTL_MS,
} from './plugins.ts'

const component = {
  id: 'selection',
  entry: 'selection.js',
  preview: 'scenario.json',
  actions: [{ id: 'select', capability: 'interaction.answer' }],
}
const message = {
  channel: PLUGIN_MESSAGE_CHANNEL,
  lease: 'current',
  action: 'select',
  values: { selected_paper_ids: ['paper-a'] },
}

test('plot exports are bounded revision-bound data, never copy, actions or paths', () => {
  const request = {
    channel: PLUGIN_MESSAGE_CHANNEL,
    lease: 'current',
    requestId: 'plot-export',
    revision: 3,
    exportPlot: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  }
  assert.deepEqual(componentPlotExport(request, 'current'), {
    requestId: request.requestId,
    revision: 3,
    plot: request.exportPlot,
  })
  const { exportPlot, ...envelope } = request
  const copy = { ...envelope, copyPlot: exportPlot }
  assert.deepEqual(componentPlotExport(copy, 'current'), {
    requestId: request.requestId,
    revision: 3,
    plot: exportPlot,
    copy: true,
  })
  assert.equal(componentPlotExport({ ...copy, exportPlot }, 'current'), null)
  assert.equal(componentCopy(copy, 'current'), null)
  for (const invalid of [
    { ...request, lease: 'old' },
    { ...request, revision: -1 },
    { ...request, requestId: 'bad id' },
    { ...request, exportPlot: [] },
    { ...request, action: 'save', values: {} },
    { ...request, copyText: 'text' },
    { ...request, path: '/outside.svg' },
    { ...request, exportPlot: { svg: 'a'.repeat(PLUGIN_MAX_PLOT_BYTES) } },
  ])
    assert.equal(componentPlotExport(invalid, 'current'), null)
  assert.equal(componentCopy(request, 'current'), null)
  assert.equal(componentAction(request, 'current', component), null)
})

test('component requests, drafts and copying accept large generated data', () => {
  const text = '字'.repeat(100000)
  const action = { ...message, values: { text } }
  assert.deepEqual(componentAction(action, 'current', component)?.values, { text })
  assert.deepEqual(componentRPC({ ...action, requestId: 'large' }, 'current')?.values, { text })
  assert.deepEqual(
    componentDraft(
      { channel: PLUGIN_MESSAGE_CHANNEL, lease: 'current', requestId: 'large', draft: { text } },
      'current'
    )?.values,
    { text }
  )
  const copy = {
    channel: PLUGIN_MESSAGE_CHANNEL,
    lease: 'current',
    requestId: 'large',
    revision: 0,
  }
  assert.deepEqual(componentCopy({ ...copy, copy: { text } }, 'current')?.content, { text })
  assert.equal(componentCopyText({ ...copy, copyText: text }, 'current')?.text, text)
})

test('copy grants require first handshake, matching secret, monotonic proof and one-use current revision', () => {
  let now = 0
  const gesture = createComponentGesture(() => now)
  const init = {
    channel: PLUGIN_MESSAGE_CHANNEL,
    lease: 'current',
    gesture: 'init',
    secret: 'a'.repeat(64),
  }
  const proof = { ...init, gesture: 'proof', sequence: 1, issued: now }
  assert.equal(gesture.receive(proof, 'current', 2), false)
  assert.equal(gesture.receive(init, 'current', 2), true)
  assert.equal(gesture.receive({ ...init, secret: 'b'.repeat(64) }, 'current', 2), false)
  assert.equal(gesture.receive({ ...proof, secret: 'b'.repeat(64) }, 'current', 2), false)
  assert.equal(gesture.receive(proof, 'old', 2), false)
  assert.equal(gesture.consume(2), false)
  assert.equal(gesture.receive(proof, 'current', 2), true)
  assert.equal(gesture.consume(2), true)
  assert.equal(gesture.consume(2), false)
  assert.equal(gesture.receive(proof, 'current', 2), false)
  assert.equal(gesture.receive({ ...proof, sequence: 2 }, 'current', 2), true)
  assert.equal(gesture.consume(3), false)
  assert.equal(gesture.consume(2), false)
  assert.equal(gesture.receive({ ...proof, sequence: 3 }, 'current', 3), true)
  now += PLUGIN_GESTURE_TTL_MS + 1
  assert.equal(gesture.consume(3), false)
  assert.equal(gesture.receive({ ...proof, sequence: 4 }, 'current', 3), false)
  assert.equal(gesture.receive({ ...proof, sequence: 4, issued: now + 1 }, 'current', 3), false)
  assert.equal(gesture.receive({ ...proof, sequence: 4, issued: now }, 'current', 3), true)
  assert.equal(gesture.consume(3), true)
  assert.equal(gesture.receive({ ...proof, sequence: 4, isTrusted: true }, 'current', 3), false)
})

test('explicit copy is bounded, revision-bound text and cannot impersonate registration or actions', () => {
  const request = {
    channel: PLUGIN_MESSAGE_CHANNEL,
    lease: 'current',
    requestId: 'copy-click',
    revision: 3,
    copyText: 'theorem total : 9 + 3 = 12 := by rfl',
  }
  assert.deepEqual(componentCopyText(request, 'current'), {
    requestId: request.requestId,
    revision: 3,
    text: request.copyText,
  })
  for (const invalid of [
    { ...request, lease: 'old' },
    { ...request, revision: -1 },
    { ...request, copyText: '' },
    { ...request, copyText: ['text'] },
    { ...request, action: 'select', values: {} },
    { ...request, copy: { text: 'replace registration' } },
    { ...request, requestId: 'bad id' },
  ])
    assert.equal(componentCopyText(invalid, 'current'), null)
  assert.equal(componentCopy(request, 'current'), null)
  assert.equal(componentAction(request, 'current', component), null)
})

test('undeclared RPC envelopes remain identifiable without granting the action', () => {
  const request = { ...message, requestId: 'open', action: 'open-results' }
  assert.deepEqual(componentRPC(request, 'current'), {
    requestId: 'open',
    action: 'open-results',
    values: message.values,
  })
  assert.equal(componentRequest(request, 'current', component), null)
  for (const invalid of [
    { ...request, lease: 'old' },
    { ...request, requestId: '' },
    { ...request, action: 1 },
    { ...request, values: [] },
    { ...request, copyText: 'injected' },
  ])
    assert.equal(componentRPC(invalid, 'current'), null)
})

test('copy registration is bounded text for the current lease and state, not a clipboard action', () => {
  const copy = {
    channel: PLUGIN_MESSAGE_CHANNEL,
    lease: 'current',
    requestId: 'copy-1',
    revision: 2,
    copy: { text: '阅读重点：证据', markdown: '**证据**' },
  }
  assert.deepEqual(componentCopy(copy, 'current'), {
    requestId: 'copy-1',
    revision: 2,
    content: copy.copy,
  })
  for (const invalid of [
    { ...copy, lease: 'old' },
    { ...copy, revision: -1 },
    { ...copy, revision: 1.2 },
    { ...copy, copy: { html: '<script>bad()</script>' } },
    { ...copy, copy: { text: '' } },
    { ...copy, action: 'write-clipboard' },
    { ...copy, requestId: '' },
  ])
    assert.equal(componentCopy(invalid, 'current'), null)
  assert.equal(componentAction(copy, 'current', component), null)
})

test('draft state is correlated and cannot spoof actions or another component instance', () => {
  const draft = {
    channel: PLUGIN_MESSAGE_CHANNEL,
    lease: 'current',
    requestId: 'draft-1',
    draft: { selected: ['paper'] },
  }
  assert.deepEqual(componentDraft(draft, 'current'), { requestId: 'draft-1', values: draft.draft })
  for (const invalid of [
    { ...draft, lease: 'other' },
    { ...draft, action: 'select' },
    { ...draft, draft: [] },
    { ...draft, requestId: '' },
  ])
    assert.equal(componentDraft(invalid, 'current'), null)
  assert.equal(componentAction(draft, 'current', component), null)
})

test('component messages admit only declared actions and the current instance', () => {
  assert.deepEqual(componentAction(message, 'current', component), {
    action: 'select',
    values: message.values,
  })
  for (const invalid of [
    { ...message, lease: 'expired' },
    { ...message, action: 'delete' },
    { ...message, session_id: 'another' },
    { ...message, values: [] },
    { ...message, channel: 'other' },
  ])
    assert.equal(componentAction(invalid, 'current', component), null)
})

test('unserializable component payloads are rejected without throwing', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  for (const values of [circular, { count: BigInt(1) }]) {
    assert.equal(componentAction({ ...message, values }, 'current', component), null)
  }
})

test('RPC requests preserve correlation and require a declared action and matching lease', () => {
  const request = { ...message, requestId: 'request-1' }
  assert.deepEqual(componentRequest(request, 'current', component), {
    requestId: 'request-1',
    action: 'select',
    values: message.values,
  })
  for (const invalid of [
    { ...request, requestId: '' },
    { ...request, requestId: 1 },
    { ...request, lease: 'old' },
    { ...request, action: 'unknown' },
    { ...request, projectId: 'foreign' },
  ]) {
    assert.equal(componentRequest(invalid, 'current', component), null)
  }
  assert.equal(componentAction(request, 'current', component), null)
})

test('component geometry is bounded and cannot authorize an action', () => {
  const resize = { channel: PLUGIN_MESSAGE_CHANNEL, lease: 'current', height: 600 }
  assert.equal(componentHeight(resize, 'current'), 600)
  assert.equal(
    componentHeight({ ...resize, height: PLUGIN_MAX_FRAME_HEIGHT * 2 }, 'current'),
    PLUGIN_MAX_FRAME_HEIGHT
  )
  for (const invalid of [
    { ...resize, height: -1 },
    { ...resize, height: Infinity },
    { ...resize, lease: 'old' },
    { ...resize, action: 'select' },
  ])
    assert.equal(componentHeight(invalid, 'current'), null)
})
