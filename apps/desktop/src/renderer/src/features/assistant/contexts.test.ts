import assert from 'node:assert/strict'
import test from 'node:test'
import { overviewReferenceGroups, selectionReferenceGroups } from './contexts.ts'
import type { MessageReference } from '../../model.ts'

test('selection groups use document identity and retain each snapshot, revision and locator', () => {
  const selection: MessageReference = {
    type: 'assistant_context',
    kind: 'literature',
    id: 'one',
    title: '同名论文',
    sourceId: 'paper',
    snapshotId: 'snapshot-1',
    sourceRevision: 'old',
    anchor: { documentId: 'pdf', previewText: '片段一', locator: { kind: 'pdf', page: 1 } },
  }
  const second = {
    ...selection,
    id: 'two',
    snapshotId: 'snapshot-2',
    sourceRevision: 'new',
    anchor: { ...selection.anchor, previewText: '片段二', locator: { kind: 'pdf', page: 2 } },
  }
  const other = { ...selection, id: 'other', sourceId: 'another-paper' }
  const attachment = {
    ...selection,
    id: 'attachment',
    anchor: { ...selection.anchor, documentId: 'another-pdf' },
  }
  const unknown = { ...selection, id: 'unknown', sourceId: undefined }
  const refs = [
    selection,
    other,
    second,
    attachment,
    unknown,
    { ...unknown, id: 'unknown-2' },
    { ...selection, id: 'resource', kind: 'selection' },
    { ...selection, id: 'session', kind: 'session' },
    { type: 'file', id: 'file', title: '论文' },
  ]
  const original = JSON.stringify(refs)
  const groups = selectionReferenceGroups(refs)
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.id)),
    [['one', 'two'], ['other'], ['attachment'], ['unknown'], ['unknown-2'], ['resource']]
  )
  assert.equal(groups[0].items[0], selection)
  assert.equal(groups[0].items[1], second)
  assert.equal(groups[0].key, selectionReferenceGroups([selection])[0].key)
  assert.equal(JSON.stringify(refs), original)
})

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
