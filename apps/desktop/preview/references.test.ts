import assert from 'node:assert/strict'
import test from 'node:test'
import {
  previewContextReferences,
  previewDraftReferences,
  previewSubmittedReferences,
  previewMixedReferences,
  previewReferenceAnnotations,
  PREVIEW_REFERENCE_SESSION,
} from './references.ts'
import { selectionReferenceGroups } from '../src/renderer/src/features/assistant/grouping.ts'

test('reference scene preserves submitted identity independently of draft edits', () => {
  const draft = previewContextReferences()
  const submitted = previewSubmittedReferences(draft, 'first-turn')
  draft[0].anchor!.preview_text = 'changed'
  draft.splice(1, 1)
  assert.equal(submitted.length, 3)
  assert.notEqual(submitted[0].anchor!.previewText, 'changed')
  assert.equal(submitted[0].snapshotId, 'first-turn')
  assert.deepEqual(
    selectionReferenceGroups(submitted).map((group) => group.references.length),
    [2, 1]
  )
})

test('mixed reference inventory contains image, files, notes, skill and navigable session', () => {
  const refs = previewMixedReferences()
  assert.equal(refs.filter((reference) => reference.type === 'file').length, 4)
  assert.equal(refs.filter((reference) => reference.kind === 'note').length, 2)
  assert.equal(
    refs.find((reference) => reference.kind === 'session')?.source_id,
    PREVIEW_REFERENCE_SESSION
  )
  assert.equal(refs.find((reference) => reference.type === 'skill')?.title, 'research')
  assert.deepEqual(
    refs.filter((reference) => reference.kind === 'note').map((reference) => reference.source_id),
    previewReferenceAnnotations('current').map((annotation) => annotation.annotation_id)
  )
})

test('draft reference seed retains only the actual selected next-turn collection', () => {
  const draft = previewDraftReferences()
  assert.equal(draft.length, 9)
  assert.equal(new Set(draft.map((reference) => reference.ref_id)).size, draft.length)
  assert.ok(draft.every((reference) => reference.retention === 'next_turn'))
  const submitted = previewSubmittedReferences(
    draft.filter((reference) => reference.source_id !== 'measurements.csv'),
    'submitted'
  )
  assert.equal(submitted.length, 8)
  assert.ok(submitted.every((reference) => reference.sourceId !== 'measurements.csv'))
  assert.equal(submitted.filter((reference) => reference.kind === 'note').length, 2)
})
