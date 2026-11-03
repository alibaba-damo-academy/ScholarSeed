import assert from 'node:assert/strict'
import test from 'node:test'
import {
  componentAction,
  componentCopy,
  componentDraft,
  componentRequest,
  componentHeight,
  PLUGIN_MESSAGE_CHANNEL,
  PLUGIN_MAX_FRAME_HEIGHT,
  PLUGIN_MAX_MESSAGE_BYTES,
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
    { ...copy, copy: { text: '字'.repeat(PLUGIN_MAX_MESSAGE_BYTES) } },
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
