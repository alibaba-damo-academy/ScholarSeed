import assert from 'node:assert/strict'
import test from 'node:test'
import type { Root } from 'mdast'
import { remarkLiteralHtml } from '../../../../markdown/literal.ts'

test('literal HTML masks transport comments without changing source positions or code', () => {
  const position = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 50, offset: 49 },
  }
  const tree: Root = {
    type: 'root',
    children: [
      { type: 'html', value: '<!-- scholarseed-ref claim="private" -->', position },
      { type: 'html', value: '<script>unsafe()</script>' },
      { type: 'html', value: '<b>visible</b><!-- SCHOLARSEED-REF claim="private" -->' },
      {
        type: 'paragraph',
        children: [{ type: 'inlineCode', value: '<!-- scholarseed-ref example -->' }],
      },
    ],
  }
  remarkLiteralHtml()(tree)
  assert.deepEqual(tree.children[0], { type: 'text', value: '', position })
  assert.deepEqual(tree.children[1], { type: 'text', value: '<script>unsafe()</script>' })
  assert.deepEqual(tree.children[2], { type: 'text', value: '<b>visible</b>' })
  assert.deepEqual(tree.children[3], {
    type: 'paragraph',
    children: [{ type: 'inlineCode', value: '<!-- scholarseed-ref example -->' }],
  })
})
