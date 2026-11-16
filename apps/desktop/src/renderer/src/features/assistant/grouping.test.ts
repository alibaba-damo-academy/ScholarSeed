import assert from 'node:assert/strict'
import test from 'node:test'
import { draftReferenceGroups, selectionReferenceGroups } from './grouping.ts'
import type { AssistantContextRef, AnswerAnnotation } from '../../contracts/assistant.ts'

test('draft references group notes by session and selections by source document without losing entries', () => {
  const reference = (
    refId: string,
    kind: AssistantContextRef['kind'],
    sourceId: string
  ): AssistantContextRef => ({
    ref_id: refId,
    kind,
    source_id: sourceId,
    label: 'Same',
    retention: 'next_turn',
    origin: 'explicit',
  })
  const references = [
    reference('note-one', 'note', 'annotation-one'),
    {
      ...reference('selection-one', 'selection', 'file.md'),
      anchor: { document_id: 'file', preview_text: 'First' },
    },
    reference('note-two', 'note', 'annotation-two'),
    {
      ...reference('selection-two', 'selection', 'file.md'),
      anchor: { document_id: 'file', preview_text: 'Second' },
      source_revision: 'new',
    },
    reference('other-note', 'note', 'annotation-other'),
    { ...reference('other-file', 'selection', 'other.md'), anchor: { document_id: 'file' } },
    reference('missing-note', 'note', 'missing'),
    reference('file', 'file', 'file.md'),
  ] as AssistantContextRef[]
  const annotations = [
    { annotation_id: 'annotation-one', session_id: 'session' },
    { annotation_id: 'annotation-two', session_id: 'session' },
    { annotation_id: 'annotation-other', session_id: 'other-session' },
  ] as AnswerAnnotation[]
  const before = JSON.stringify(references)
  const groups = draftReferenceGroups(references, annotations)
  assert.deepEqual(
    groups.map((group) => group.map((item) => item.ref_id)),
    [
      ['note-one', 'note-two'],
      ['selection-one', 'selection-two'],
      ['other-note'],
      ['other-file'],
      ['missing-note'],
      ['file'],
    ]
  )
  assert.equal(groups[1][1], references[3])
  assert.equal(JSON.stringify(references), before)
  assert.deepEqual(
    draftReferenceGroups(references, annotations, new Set(['annotation-one']))
      .filter((group) => group[0].kind === 'note')
      .map((group) => group.map((item) => item.ref_id)),
    [['note-one'], ['note-two'], ['other-note'], ['missing-note']]
  )
})

test('groups selections by source identity and document, never by title', () => {
  const references = [
    {
      type: 'assistant_context',
      kind: 'selection',
      id: 'one',
      sourceId: 'paper',
      title: 'Same',
      anchor: { documentId: 'pdf' },
    },
    {
      type: 'assistant_context',
      kind: 'selection',
      id: 'two',
      sourceId: 'paper',
      title: 'Same',
      anchor: { documentId: 'pdf' },
    },
    {
      type: 'assistant_context',
      kind: 'selection',
      id: 'three',
      sourceId: 'other',
      title: 'Same',
      anchor: { documentId: 'pdf' },
    },
    {
      type: 'assistant_context',
      kind: 'selection',
      id: 'four',
      sourceId: 'paper',
      title: 'Same',
      anchor: { documentId: 'other-pdf' },
    },
    { type: 'assistant_context', id: 'file', title: 'Same' },
  ]
  const before = JSON.stringify(references)
  assert.deepEqual(
    selectionReferenceGroups(references).map((group) =>
      group.references.map((reference) => reference.id)
    ),
    [['one', 'two'], ['three'], ['four']]
  )
  assert.equal(JSON.stringify(references), before)
  assert.deepEqual(selectionReferenceGroups([]), [])
  assert.deepEqual(
    selectionReferenceGroups([
      {
        type: 'assistant_context',
        kind: 'pdf_comment',
        id: 'comment',
        title: 'Comment',
        anchor: { documentId: 'pdf' },
      },
    ]),
    []
  )
})
