import assert from 'node:assert/strict'
import test from 'node:test'
import { cardRequest } from './operations.ts'
import { CARD_ALLOWED_OPERATIONS, CARD_CAPABILITIES, type LiteratureCardPorts } from './ports.ts'
import { pluginErrorCode } from '../../../../plugins.ts'
import { conversationSearchSource } from './result.ts'
import type { ConversationSearchPaper } from '../../contracts/literature.ts'

test('search source navigation resolves only the bound paper and rejects unsafe destinations', () => {
  const papers = [
    { id: 'doi-paper', doi: '10.1000/example', url: 'https://example.org/paper' },
    { id: 'unsafe', doi: null, url: 'javascript:alert(1)' },
    { id: 'file', doi: null, url: 'file:///private/source.pdf' },
    { id: 'web', doi: null, url: 'https://example.org/original#method' },
  ] as ConversationSearchPaper[]
  assert.equal(conversationSearchSource(papers, 'doi-paper'), 'https://doi.org/10.1000/example')
  assert.equal(conversationSearchSource(papers, 'web'), 'https://example.org/original#method')
  for (const id of ['unsafe', 'file', 'missing'])
    assert.equal(conversationSearchSource(papers, id), null)
  assert.equal(papers[0].url, 'https://example.org/paper')
})

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
  await assert.rejects(request('open-source', { refId: 'paper', url: 'https://unbound.example' }))
  await assert.rejects(request('open-source', { refId: 'paper', sessionId: 'another-session' }))
})

test('host scopes operations to the card domain rather than trusting package declarations', () => {
  assert.deepEqual(CARD_ALLOWED_OPERATIONS['literature-search'], ['open-results', 'open-source'])
  assert.equal(CARD_ALLOWED_OPERATIONS['literature-search'].includes('add-reference'), false)
  assert.equal(CARD_CAPABILITIES['open-source'], 'navigation.open')
  assert.deepEqual(Object.keys(CARD_ALLOWED_OPERATIONS).sort(), [
    'literature-review',
    'literature-search',
  ])
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
