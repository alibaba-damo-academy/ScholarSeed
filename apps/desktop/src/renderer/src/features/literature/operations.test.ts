import assert from 'node:assert/strict'
import test from 'node:test'
import { cardRequest } from './operations.ts'
import { CARD_ALLOWED_OPERATIONS, CARD_CAPABILITIES, type LiteratureCardPorts } from './ports.ts'
import { pluginErrorCode } from '../../../../plugins.ts'

test('card requests reject unknown operations and arguments before invoking a host port', async () => {
  const calls: unknown[] = []
  const request = cardRequest({
    openResults: async () => {
      calls.push('open')
    },
  } as unknown as LiteratureCardPorts)
  await assert.rejects(request('constructor', {}))
  await assert.rejects(request('open-results', { sessionId: 'another-session' }))
  assert.deepEqual(calls, [])
  await request('open-results', {})
  assert.deepEqual(calls, ['open'])
})

test('save validates conflict decisions and forbids guest supplied filesystem destinations', async () => {
  const calls: unknown[] = []
  const request = cardRequest({
    save: async (choice: unknown) => {
      calls.push(choice)
      return { ok: true }
    },
  } as unknown as LiteratureCardPorts)
  const choice = {
    target: 'project',
    parent: '',
    ticket: '',
    add_to_library: false,
    collection_id: '',
  }
  for (const extra of [
    { directory: '/tmp' },
    { project_id: null },
    { project_id: 1 },
    { versions: [] },
    { versions: { paper: 'overwrite' } },
    { versions: null },
  ]) {
    await assert.rejects(request('save', { choice: { ...choice, ...extra } }))
  }
  assert.deepEqual(calls, [])
  await request('save', {
    choice: { ...choice, project_id: 'selected-project', versions: { paper: 'keep_both' } },
  })
  assert.equal(calls.length, 1)
})

test('project selection reaches folder and collection ports without changing card scope', async () => {
  const calls: unknown[] = []
  const request = cardRequest({
    folders: async (...args: unknown[]) => {
      calls.push(args)
      return null
    },
    collections: async (...args: unknown[]) => {
      calls.push(args)
      return []
    },
  } as unknown as LiteratureCardPorts)
  await request('folders', { parent: '', offset: 0, projectId: 'selected-project' })
  await request('collections', { projectId: 'selected-project' })
  assert.deepEqual(calls, [['', 0, 'selected-project'], ['selected-project']])
  await assert.rejects(request('folders', { parent: '', offset: 0, projectId: null }))
  await assert.rejects(request('collections', { projectId: 1 }))
})

test('folder offsets must be finite nonnegative integers', async () => {
  const request = cardRequest({ folders: async () => null } as unknown as LiteratureCardPorts)
  for (const offset of [-1, 0.5, Infinity, '0'])
    await assert.rejects(request('folders', { parent: '', offset }))
  assert.equal(await request('folders', { parent: '', offset: 0 }), null)
})

test('host scopes operations to the card domain rather than trusting package declarations', () => {
  assert.deepEqual(CARD_ALLOWED_OPERATIONS['literature-search'], ['open-results'])
  assert.equal(CARD_ALLOWED_OPERATIONS['literature-downloads'].includes('create-collection'), false)
  assert.equal(CARD_ALLOWED_OPERATIONS['literature-review'].includes('save'), false)
  for (const operations of Object.values(CARD_ALLOWED_OPERATIONS)) {
    for (const operation of operations) assert.ok(CARD_CAPABILITIES[operation])
  }
})

test('business error codes survive the sandbox without forwarding arbitrary error objects', () => {
  assert.equal(
    pluginErrorCode({ failure: { code: 'COLLECTION_NAME_EXISTS' } }),
    'COLLECTION_NAME_EXISTS'
  )
  assert.equal(pluginErrorCode({ code: 'COLLECTION_PARENT_INVALID' }), 'COLLECTION_PARENT_INVALID')
  assert.equal(pluginErrorCode({ code: { secret: 'not forwarded' } }), undefined)
  assert.equal(pluginErrorCode({ code: '/private/credential' }), undefined)
})
