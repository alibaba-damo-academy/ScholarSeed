import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfRecordSnapshot, PdfRecords } from '../../../contracts/workbench.ts'
import { createPointMark, stagePdfRecords } from './records.ts'

test('point comment drafts and saved marks share position identity without inventing source text', () => {
  const mark = createPointMark(3, [0.25, 0.75])
  assert.equal(mark.style, 'comment')
  assert.equal(mark.page, 3)
  assert.deepEqual(mark.point, [0.25, 0.75])
  assert.deepEqual(mark.quads, [])
  assert.equal(mark.text, '')
  assert.ok(mark.id)
  assert.equal(mark.created_at, mark.updated_at)
})

const records: PdfRecords = {
  schema_version: 1,
  marks: [],
  comments: [],
  notes: [],
}

const snapshot: PdfRecordSnapshot = {
  record_target: {
    owner: 'literature_attachment',
    scope_id: 'paper',
    subject_id: 'attachment',
  },
  record_revision: 'records-before',
  source_revision: 'source-current',
  source_state: 'available',
  source_path: 'paper.pdf',
  records,
}

test('staging PDF records updates the visible payload without claiming a committed revision', () => {
  const pending: PdfRecords = {
    ...records,
    marks: [
      {
        id: 'pending-mark',
        style: 'highlight',
        color: 'yellow',
        page: 1,
        quads: [[0.1, 0.2, 0.3, 0.4]],
        text: 'pending',
        anchor_state: 'anchored',
        created_at: 1,
        updated_at: 1,
      },
    ],
  }

  const staged = stagePdfRecords(snapshot, pending)

  assert.notEqual(staged, snapshot)
  assert.equal(staged.records, pending)
  assert.equal(staged.record_revision, snapshot.record_revision)
  assert.equal(staged.source_revision, snapshot.source_revision)
  assert.equal(snapshot.records.marks.length, 0)
})

test('staged edits retain native provenance so the PDF does not reload its original appearances', () => {
  const imported = {
    ...snapshot,
    records: {
      ...records,
      native_annotations: [
        {
          id: 'native',
          page: 1,
          subtype: '/Text',
          name: '',
          rect: [0, 0, 1, 1],
          contents: 'note',
          author: '',
          created: '',
          modified: '',
        },
      ],
    },
  }
  assert.deepEqual(
    stagePdfRecords(imported, records).records.native_annotations,
    imported.records.native_annotations
  )
})
