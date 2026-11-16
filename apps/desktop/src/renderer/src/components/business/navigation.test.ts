import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConvItem } from '../../model'
import {
  conversationTurns,
  currentConversationTurn,
  visibleConversationTurns,
  turnMarkerProximity,
  turnNavigationVisible,
} from './navigation.ts'

test('visible turns include partial answers and every question intersecting the viewport', () => {
  const anchors = [
    { key: 'first', top: -400 },
    { key: 'second', top: 100 },
    { key: 'third', top: 300 },
    { key: 'fourth', top: 600 },
  ]
  assert.deepEqual(visibleConversationTurns(anchors, 0, 500, 800), ['first', 'second', 'third'])
  assert.deepEqual(visibleConversationTurns(anchors, 100, 300, 800), ['second'])
  assert.deepEqual(visibleConversationTurns(anchors, 700, 900, 800), ['fourth'])
  assert.deepEqual(visibleConversationTurns(anchors, 800, 900, 800), [])
  assert.deepEqual(visibleConversationTurns([], 0, 500, 800), [])
})

test('turn rail requires five turns and at least 70px of existing left gutter', () => {
  assert.equal(turnNavigationVisible(4, 200), false)
  assert.equal(turnNavigationVisible(5, 69.9), false)
  assert.equal(turnNavigationVisible(5, 70), true)
  assert.equal(turnNavigationVisible(20, 140), true)
})

test('current turn follows the last question above the reading edge, including legacy keys', () => {
  const anchors = [
    { key: 'legacy', top: 40 },
    { key: 'next', top: 240 },
  ]
  assert.equal(currentConversationTurn(anchors, 0), 'legacy')
  assert.equal(currentConversationTurn(anchors, 240), 'next')
  assert.equal(
    currentConversationTurn([anchors[0], { key: 'aligned', top: 240.9 }], 240),
    'aligned'
  )
  assert.equal(currentConversationTurn(anchors, 239), 'legacy')
  assert.equal(currentConversationTurn(anchors, 500), 'next')
  assert.equal(currentConversationTurn([], 0), undefined)
})

test('hover magnification tapers symmetrically and resets outside the rail', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => turnMarkerProximity(index, 4)),
    ['rest', 'outer', 'far', 'near', 'focused', 'near', 'far', 'outer', 'rest']
  )
  assert.equal(turnMarkerProximity(3, null), 'rest')
})

test('turn binding keeps the input anchor key so an open preview and keyboard focus survive', () => {
  const pending = conversationTurns([
    { kind: 'user', itemId: 'message', turnId: 'client', text: 'Question' },
  ])
  const bound = conversationTurns(
    [{ kind: 'user', itemId: 'message', turnId: 'native', text: 'Question' }],
    { native: 'running' }
  )
  assert.equal(pending[0].key, bound[0].key)
  assert.equal(bound[0].state, 'running')
  assert.equal(bound[0].itemId, 'message')
})

test('turn navigation preserves identity and joins only the matching public answers', () => {
  const items: ConvItem[] = [
    { kind: 'user', turnId: 'first', itemId: 'question-one', text: 'Same question' },
    { kind: 'agent', turnId: 'first', text: 'First paragraph' },
    { kind: 'thinking', turnId: 'first', text: 'Private reasoning' },
    { kind: 'agent', turnId: 'first', text: 'Second paragraph' },
    { kind: 'status', turnId: 'internal', text: '' },
    { kind: 'agent', turnId: 'internal', text: 'Internal continuation' },
    { kind: 'user', turnId: 'second', itemId: 'question-two', text: 'Same question' },
    { kind: 'agent', turnId: 'second', text: 'Different answer' },
  ]
  const turns = conversationTurns(items, { first: 'completed', second: 'completed' })
  assert.deepEqual(
    turns.map(({ turnId, itemId, question, answer }) => ({ turnId, itemId, question, answer })),
    [
      {
        turnId: 'first',
        itemId: 'question-one',
        question: 'Same question',
        answer: 'First paragraph Second paragraph',
      },
      {
        turnId: 'second',
        itemId: 'question-two',
        question: 'Same question',
        answer: 'Different answer',
      },
    ]
  )
})

test('attachment-only input uses displayed names, not native paths or empty text', () => {
  const turns = conversationTurns(
    [
      {
        kind: 'user',
        turnId: 'files',
        text: '',
        refs: [
          {
            type: 'file',
            id: 'file-one',
            title: 'measurement.csv',
            path: '/private/account/measurement.csv',
          },
          { type: 'file', id: 'file-two', title: 'notes.txt' },
          {
            type: 'assistant_context',
            kind: 'file',
            id: 'project-file',
            title: 'project.md',
            sourceId: 'notes/project.md',
          },
        ],
      },
    ],
    { files: 'running' }
  )
  assert.equal(turns[0].question, 'measurement.csv, notes.txt, project.md')
  assert.equal(turns[0].state, 'running')
  assert.equal(turns[0].answer, '')
})

test('waiting and terminal states stay authoritative without fabricating answers', () => {
  const items: ConvItem[] = ['waiting', 'failed', 'interrupted', 'completed', 'unknown'].map(
    (turnId) => ({ kind: 'user', turnId, text: turnId })
  )
  const turns = conversationTurns(
    items,
    {
      waiting: 'running',
      failed: 'failed',
      interrupted: 'interrupted',
      completed: 'completed',
      unknown: 'unknown',
    },
    new Set(['waiting'])
  )
  assert.deepEqual(
    turns.map(({ state }) => state),
    ['waiting', 'failed', 'interrupted', 'completed', 'unknown']
  )
  assert.ok(turns.every(({ answer }) => answer === ''))
})

test('legacy messages keep their item anchors and do not absorb another owned turn', () => {
  const turns = conversationTurns([
    { kind: 'user', itemId: 'legacy-one', text: 'Old question' },
    { kind: 'agent', text: 'Old answer' },
    { kind: 'user', itemId: 'legacy-two', text: 'Another old question' },
    { kind: 'agent', turnId: 'internal', text: 'Not this answer' },
    { kind: 'agent', text: 'Another old answer' },
  ])
  assert.deepEqual(
    turns.map(({ itemId, answer }) => ({ itemId, answer })),
    [
      { itemId: 'legacy-one', answer: 'Old answer' },
      { itemId: 'legacy-two', answer: 'Another old answer' },
    ]
  )
})

test('steering within one turn does not add a duplicate entry or replace its question anchor', () => {
  const turns = conversationTurns([
    { kind: 'user', turnId: 'one', itemId: 'original', text: 'Original' },
    { kind: 'user', turnId: 'one', itemId: 'steer', text: 'Additional input', steer: true },
    { kind: 'agent', turnId: 'one', text: 'Answer' },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].itemId, 'original')
  assert.equal(turns[0].question, 'Original')
})
