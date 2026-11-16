import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfRecordSnapshot } from '../../contracts/workbench'
import { insightMarks, insightRequest } from './insights.ts'

const identity = { color: 'yellow' as const, created_at: 0, updated_at: 0 }
const snapshot: PdfRecordSnapshot = {
  record_target: { owner: 'literature_attachment', scope_id: 'paper', subject_id: 'pdf' },
  source_revision: 'sha256:one',
  record_revision: 'records:one',
  source_state: 'available',
  source_path: '',
  records: {
    schema_version: 1,
    marks: [
      {
        ...identity,
        id: 'text',
        style: 'highlight',
        page: 2,
        text: 'Selected text',
        anchor_state: 'anchored',
        quads: [[0.1, 0.1, 0.5, 0.2]],
      },
      {
        ...identity,
        id: 'point',
        style: 'comment',
        page: 1,
        text: '',
        anchor_state: 'anchored',
        point: [0.2, 0.3],
        quads: [],
      },
      {
        ...identity,
        id: 'stale',
        style: 'underline',
        page: 1,
        text: 'Not current',
        anchor_state: 'stale',
        quads: [[0.1, 0.1, 0.5, 0.2]],
      },
      {
        ...identity,
        id: 'empty',
        style: 'comment',
        page: 1,
        text: '',
        anchor_state: 'anchored',
        point: [0.2, 0.3],
        quads: [],
      },
    ],
    comments: [{ id: 'thought', mark_id: 'point', body: 'My thought', created_at: 0 }],
    notes: [],
  },
}

test('annotation choices include point comments and exclude stale or empty signals', () => {
  assert.deepEqual(
    insightMarks(snapshot).map((mark) => mark.id),
    ['point', 'text']
  )
  assert.deepEqual(insightMarks(null), [])
})

test('submission freezes exact identities, revisions and selected model', () => {
  assert.deepEqual(insightRequest(snapshot, new Set(['point']), 'exact:model', 'zh-CN'), {
    attachment_id: 'pdf',
    source_revision: 'sha256:one',
    record_revision: 'records:one',
    mark_ids: ['point'],
    model_key: 'exact:model',
    language: 'zh',
  })
  for (const selected of [new Set<string>(), new Set(['stale']), new Set(['text', 'missing'])]) {
    assert.throws(() => insightRequest(snapshot, selected, 'exact:model', 'en'))
  }
  assert.throws(() => insightRequest(snapshot, new Set(['text']), '', 'en'))
})
