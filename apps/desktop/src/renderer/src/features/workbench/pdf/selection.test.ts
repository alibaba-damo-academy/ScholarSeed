import assert from 'node:assert/strict'
import test from 'node:test'

import type { PdfAiResult, PdfSelection } from './analysis.ts'
import {
  selectionResultForSnapshot,
  selectionSnapshotCurrent,
  translationSnapshot,
} from './selection.ts'

const selected: PdfSelection[] = [
  { page: 10, text: 'Models of natural language.', quads: [[0, 0, 1, 1]] },
]
const choice = { engine: 'ai:model', source: 'auto', target: 'en' }
const snapshot = (attemptId = 'attempt') =>
  translationSnapshot({
    document: 'document:revision',
    selection: selected,
    choice,
    modelKey: 'model',
    revision: 'sha256:revision',
    attemptId,
  })
const result = (): PdfAiResult => ({
  kind: 'selection_translation',
  revision: 'revision',
  literature_id: 'paper',
  page: 10,
  selected_text: selected[0].text,
  model_key: 'model',
  target_language: 'en',
  client_attempt_id: 'attempt',
  quads: selected[0].quads,
  text: selected[0].text,
})

test('translation snapshots freeze selected source and choices independently of mutable inputs', () => {
  const mutableChoice = { ...choice }
  const mutableSelection = structuredClone(selected)
  const frozen = translationSnapshot({
    document: 'document',
    selection: mutableSelection,
    choice: mutableChoice,
    modelKey: 'model',
    revision: 'revision',
    attemptId: 'attempt',
  })
  mutableChoice.target = 'zh-CN'
  mutableSelection[0].text = 'Another selection'
  assert.equal(frozen.choice.target, 'en')
  assert.equal(frozen.text, selected[0].text)
  assert.notEqual(frozen.selection, JSON.stringify(mutableSelection))
})

test('a late task cannot become current for a different selection or document revision', () => {
  const frozen = snapshot()
  assert.equal(
    selectionSnapshotCurrent(frozen, 'document:revision', JSON.stringify(selected)),
    true
  )
  assert.equal(
    selectionSnapshotCurrent(
      frozen,
      'document:revision',
      JSON.stringify([{ ...selected[0], text: 'New selection' }])
    ),
    false
  )
  assert.equal(
    selectionSnapshotCurrent(frozen, 'document:next-revision', JSON.stringify(selected)),
    false
  )
})

test('a result must match the immutable attempt, source, target, page, revision and model', () => {
  const frozen = snapshot()
  const valid = result()
  assert.equal(selectionResultForSnapshot(valid, frozen), valid)
  assert.ok(selectionResultForSnapshot({ ...valid, revision: 'sha256:revision' }, frozen))
  const changes: Partial<PdfAiResult>[] = [
    { client_attempt_id: 'previous-attempt' },
    { client_attempt_id: undefined },
    { selected_text: 'Previous selection' },
    { target_language: 'zh-CN' },
    { page: 9 },
    { quads: [[0, 0, 0.5, 0.5]] },
    { revision: 'previous-revision' },
    { model_key: 'another-model' },
  ]
  for (const change of changes)
    assert.equal(selectionResultForSnapshot({ ...valid, ...change }, frozen), undefined)
  assert.equal(selectionResultForSnapshot(valid, undefined), undefined)
  assert.equal(selectionResultForSnapshot(undefined, frozen), undefined)
})

test('old results may retain their applied language but never acquire a newer attempt identity', () => {
  const previous = snapshot()
  const next = snapshot('next-attempt')
  assert.equal(selectionResultForSnapshot(result(), previous)?.target_language, 'en')
  assert.equal(selectionResultForSnapshot(result(), next), undefined)
})
