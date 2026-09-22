import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfRecordSnapshot, PdfRecords } from '../../../contracts/workbench.ts'
import { stagePdfRecords } from './records.ts'

const records: PdfRecords = {
  schema_version: 1,
  marks: [],
  comments: [],
  notes: []
}

const snapshot: PdfRecordSnapshot = {
  record_target: {
    owner: 'literature_attachment',
    scope_id: 'paper',
    subject_id: 'attachment'
  },
  record_revision: 'records-before',
  source_revision: 'source-current',
  source_state: 'available',
  source_path: 'paper.pdf',
  records
}

test('staging PDF records updates the visible payload without claiming a committed revision', () => {
  const pending: PdfRecords = {
    ...records,
    marks: [{
      id: 'pending-mark',
      style: 'highlight',
      color: 'yellow',
      page: 1,
      quads: [[0.1, 0.2, 0.3, 0.4]],
      text: 'pending',
      anchor_state: 'anchored',
      created_at: 1,
      updated_at: 1
    }]
  }

  const staged = stagePdfRecords(snapshot, pending)

  assert.notEqual(staged, snapshot)
  assert.equal(staged.records, pending)
  assert.equal(staged.record_revision, snapshot.record_revision)
  assert.equal(staged.source_revision, snapshot.source_revision)
  assert.equal(snapshot.records.marks.length, 0)
})
