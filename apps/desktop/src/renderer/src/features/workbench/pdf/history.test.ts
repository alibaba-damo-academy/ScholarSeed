import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfRecordSnapshot, PdfRecords } from '../../../contracts/workbench.ts'
import { PdfUndoHistory } from './history.ts'

const empty: PdfRecords = { schema_version: 1, marks: [], comments: [], notes: [] }
const marked: PdfRecords = {
  ...empty,
  marks: [{ id: 'mark', style: 'highlight', color: 'yellow', page: 1, quads: [[0, 0, 1, 1]], text: 'source', anchor_state: 'anchored', created_at: 1, updated_at: 1 }],
  comments: [{ id: 'comment', mark_id: 'mark', body: 'comment', created_at: 1 }],
  notes: [{ id: 'note', title: 'note', body: '', excerpts: [{ id: 'excerpt', mark_id: 'mark', text: 'source', page: 1 }] }]
}
const snapshot = (revision: string, records = empty): PdfRecordSnapshot => ({
  record_target: { owner: 'project_asset', scope_id: 'project', subject_id: 'pdf' },
  record_revision: revision,
  source_revision: 'source',
  source_state: 'available',
  source_path: 'paper.pdf',
  records
})

test('undo walks successful annotation changes using the latest committed revision', () => {
  const history = new PdfUndoHistory()
  const initial = snapshot('initial')
  const added = snapshot('added', marked)
  const modified = snapshot('modified', { ...marked, marks: marked.marks.map(mark => ({ ...mark, color: 'blue' })) })
  history.record(initial, added)
  history.record(added, modified)
  assert.deepEqual(history.peek(modified), marked)
  const undone = snapshot('undo-modified', marked)
  history.consume(undone)
  assert.deepEqual(history.peek(undone), empty)
  history.consume(snapshot('undo-added'))
  assert.equal(history.peek(snapshot('undo-added')), null)
})

test('undo deletion restores the mark, comments and note excerpts together', () => {
  const history = new PdfUndoHistory()
  history.record(snapshot('before', marked), snapshot('deleted'))
  assert.deepEqual(history.peek(snapshot('deleted')), marked)
})

test('reading an undo candidate does not consume history before a successful save', () => {
  const history = new PdfUndoHistory()
  const current = snapshot('added', marked)
  history.record(snapshot('before'), current)
  assert.deepEqual(history.peek(current), empty)
  assert.deepEqual(history.peek(current), empty)
})

test('a new edit after undo remains undoable without creating redo history', () => {
  const history = new PdfUndoHistory()
  history.record(snapshot('before'), snapshot('added', marked))
  const undone = snapshot('undone')
  history.consume(undone)
  const changed = snapshot('new-edit', marked)
  history.record(undone, changed)
  assert.deepEqual(history.peek(changed), empty)
  history.consume(snapshot('new-undo'))
  assert.equal(history.peek(snapshot('new-undo')), null)
})

for (const change of [
  { record_revision: 'external' },
  { source_revision: 'replaced-source' },
  { record_target: { owner: 'project_asset' as const, scope_id: 'project', subject_id: 'other' } },
  { source_state: 'missing' as const }
]) {
  test(`external snapshot invalidates history: ${Object.keys(change).join()}`, () => {
    const history = new PdfUndoHistory()
    const current = snapshot('added', marked)
    history.record(snapshot('before'), current)
    assert.equal(history.peek({ ...current, ...change }), null)
    assert.equal(history.peek(current), null)
  })
}

test('new edits after an external update cannot undo another writer changes', () => {
  const history = new PdfUndoHistory()
  history.record(snapshot('before'), snapshot('added', marked))
  const external = snapshot('external', marked)
  const current = snapshot('local-edit')
  history.record(external, current)
  assert.deepEqual(history.peek(current), marked)
  history.consume(snapshot('undone', marked))
  assert.equal(history.peek(snapshot('undone', marked)), null)
})

test('history instances never share document edits', () => {
  const first = new PdfUndoHistory()
  const second = new PdfUndoHistory()
  first.record(snapshot('before'), snapshot('added', marked))
  assert.equal(second.peek(snapshot('added', marked)), null)
  assert.deepEqual(first.peek(snapshot('added', marked)), empty)
})
