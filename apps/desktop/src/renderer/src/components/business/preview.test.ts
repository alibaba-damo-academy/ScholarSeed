import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreviewSession } from './preview.ts'

test('preview actions retain input-dependent state and reset with a new session', () => {
  const scenario = { data: {}, state: { collections: [] }, responses: {
    create: { state: 'resolved' as const, data: { result: { $input: 'name' } }, append: { collections: { name: { $input: 'name' } } } },
    list: { state: 'resolved' as const, data: { result: { $state: 'collections' } } },
  } }
  const session = createPreviewSession(scenario)
  assert.equal(session.execute('create', { name: 'My collection' }).data.result, 'My collection')
  assert.deepEqual(session.execute('list', {}).data.result, [{ name: 'My collection' }])
  assert.deepEqual(createPreviewSession(scenario).execute('list', {}).data.result, [])
})

test('preview failures consume one step and retry uses the preserved state', () => {
  const scenario = { data: {}, responses: { save: { state: 'resolved' as const, data: { result: { $input: 'choice' } }, steps: [{ state: 'failed' as const, data: { error: 'save_failed' } }] } } }
  const session = createPreviewSession(scenario)
  assert.equal(session.execute('save', { choice: 'project' }).state, 'failed')
  assert.deepEqual(session.execute('save', { choice: 'project' }).data.result, 'project')
  assert.throws(() => session.execute('undeclared', {}), /plugin_preview_response_missing/)
})

test('preview reference traversal rejects prototype access and missing input', () => {
  for (const field of ['__proto__', 'constructor', 'missing']) {
    const session = createPreviewSession({ data: {}, responses: { read: { state: 'resolved', data: { result: { $input: field } } } } })
    assert.throws(() => session.execute('read', {}), /plugin_preview_reference_invalid/)
  }
})

test('preview conditional writes preserve unchosen branches and optional input', () => {
  const session = createPreviewSession({ data: {}, state: { saved: false }, responses: {
    save: { state: 'resolved', set: { saved: { $if: { $input: 'choice.skip', $default: false }, equals: true, then: false, else: true } }, data: { result: { $state: 'saved' } } },
  } })
  assert.equal(session.execute('save', { choice: {} }).data.result, true)
  assert.equal(session.execute('save', { choice: { skip: true } }).data.result, false)
})

test('invalid preview transition is atomic and does not consume retry steps', () => {
  const session = createPreviewSession({ data: {}, state: { saved: false }, responses: {
    save: { state: 'resolved', data: {}, steps: [{ state: 'resolved', set: { saved: true }, data: { result: { $input: 'required' } } }] },
    read: { state: 'resolved', data: { result: { $state: 'saved' } } },
  } })
  assert.throws(() => session.execute('save', {}), /plugin_preview_reference_invalid/)
  assert.equal(session.execute('read', {}).data.result, false)
  assert.equal(session.execute('save', { required: 'retry' }).data.result, 'retry')
  assert.equal(session.execute('read', {}).data.result, true)
})

test('detail responses read the current scenario data instead of copying a different sample', () => {
  const scenario = { data: { papers: [{ id: 'current', title: '当前结果' }] }, responses: {
    open: { state: 'resolved' as const, data: { target: { component: 'details', data: { papers: { $data: 'papers' } } } } },
  } }
  const session = createPreviewSession(scenario)
  assert.deepEqual(session.execute('open', {}).data.target, { component: 'details', data: scenario.data })
})
