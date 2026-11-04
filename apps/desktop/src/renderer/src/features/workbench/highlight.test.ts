import assert from 'node:assert/strict'
import test from 'node:test'

import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'

import { createMarkdownFindPlugin, markdownFindKey } from './highlight.ts'

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
})
const FIRST_MATCH = { from: 1, to: 3 }
const SECOND_MATCH = { from: 7, to: 9 }

function editorState(): EditorState {
  return EditorState.create({
    doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('模型 ab 模型')])]),
    plugins: [createMarkdownFindPlugin()],
  })
}

test('Markdown search decorates a match without changing content or the editor selection', () => {
  const before = editorState()
  const after = before.apply(before.tr.setMeta(markdownFindKey, FIRST_MATCH))
  const decorations = markdownFindKey.getState(after)!.find()
  assert.equal(decorations.length, 1)
  assert.equal(decorations[0].from, FIRST_MATCH.from)
  assert.equal(decorations[0].to, FIRST_MATCH.to)
  assert.equal(after.doc, before.doc)
  assert.ok(after.selection.eq(before.selection))
  assert.equal(after.tr.docChanged, false)
})

test('Markdown search moves its only highlight with the active result', () => {
  const initial = editorState()
  const first = initial.apply(initial.tr.setMeta(markdownFindKey, FIRST_MATCH))
  const second = first.apply(first.tr.setMeta(markdownFindKey, SECOND_MATCH))
  assert.deepEqual(
    markdownFindKey
      .getState(second)!
      .find()
      .map(({ from, to }) => ({ from, to })),
    [SECOND_MATCH]
  )
})

test('Markdown search clears its highlight when the query changes, closes or has no result', () => {
  const initial = editorState()
  const highlighted = initial.apply(initial.tr.setMeta(markdownFindKey, FIRST_MATCH))
  const cleared = highlighted.apply(highlighted.tr.setMeta(markdownFindKey, null))
  assert.deepEqual(markdownFindKey.getState(cleared)!.find(), [])
  assert.equal(cleared.doc, initial.doc)
})

test('Markdown search keeps the highlight through focus and selection transactions', () => {
  const initial = editorState()
  const highlighted = initial.apply(initial.tr.setMeta(markdownFindKey, FIRST_MATCH))
  const moved = highlighted.apply(
    highlighted.tr.setSelection(TextSelection.create(highlighted.doc, SECOND_MATCH.from))
  )
  assert.equal(markdownFindKey.getState(moved), markdownFindKey.getState(highlighted))
})

test('Markdown search invalidates the old match when document contents change', () => {
  const initial = editorState()
  const highlighted = initial.apply(initial.tr.setMeta(markdownFindKey, FIRST_MATCH))
  const changed = highlighted.apply(highlighted.tr.insertText('new ', FIRST_MATCH.from))
  assert.deepEqual(markdownFindKey.getState(changed)!.find(), [])
})
