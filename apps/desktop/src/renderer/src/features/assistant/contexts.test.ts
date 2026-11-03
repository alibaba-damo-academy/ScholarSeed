import assert from 'node:assert/strict'
import test from 'node:test'
import { overviewReferenceGroups } from './contexts.ts'

test('overview groups only submitted supported references in prototype order', () => {
  const refs = [
    { type: 'assistant_context', kind: 'session', id: 'session', title: 'Task' },
    { type: 'assistant_context', kind: 'literature', id: 'paper', title: 'Paper' },
    { type: 'file', id: 'one', title: 'One.md' },
    { type: 'file', id: 'two', title: 'Two.csv' },
    { type: 'assistant_context', kind: 'selection', id: 'selection', title: 'Selection' },
    { type: 'assistant_context', kind: 'note', id: 'note', title: 'Note' },
  ]
  assert.deepEqual(
    overviewReferenceGroups(refs).map((group) => [group.kind, group.items.length]),
    [
      ['uploads', 2],
      ['files', 1],
      ['literature', 1],
      ['sessions', 1],
    ]
  )
  assert.deepEqual(overviewReferenceGroups([]), [])
})
