import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownAnchorDom, mergeMarkdownAnchors } from './anchors.ts'

test('empty Markdown anchors render inertly while retaining their exact source', () => {
  for (const source of [
    '<a id="ref-paper"></a>',
    "<A name='章节:一'> </A>",
    '<a id="tab:T1"></a>\n',
  ]) {
    const output = markdownAnchorDom(source)
    assert.ok(output)
    assert.equal(output[0], 'span')
    assert.equal(output.length, 2)
    assert.equal(output[1]['data-value'], source)
    assert.equal(output[1]['data-type'], 'html')
    assert.equal(Object.prototype.hasOwnProperty.call(output[1], 'id'), false)
  }
})

test('unsafe, nonempty, escaped and example markup remains literal', () => {
  for (const source of [
    '<a id="ref" onclick="alert(1)"></a>',
    '<a href="javascript:alert(1)"></a>',
    '<a id="ref">visible</a>',
    '<a id=""></a>',
    '<a id="ref&amp;other"></a>',
    '<a id="ref"></a><script>alert(1)</script>',
    '<a id="ref">',
    '</a>',
    '&lt;a id="ref"&gt;&lt;/a&gt;',
    '\\<a id="ref"></a>',
    '`<a id="ref"></a>`',
  ])
    assert.equal(markdownAnchorDom(source), null, source)
})

test('inline HTML token pairs merge without removing source or neighboring text', () => {
  const tree = {
    type: 'paragraph',
    children: [
      { type: 'html', value: '<a id="ref">' },
      { type: 'html', value: '</a>' },
      { type: 'text', value: 'Reference text' },
      { type: 'html', value: '<a name="second">' },
      { type: 'text', value: ' ' },
      { type: 'html', value: '</a>' },
    ],
  }
  mergeMarkdownAnchors(tree)
  assert.deepEqual(tree.children, [
    { type: 'html', value: '<a id="ref"></a>' },
    { type: 'text', value: 'Reference text' },
    { type: 'html', value: '<a name="second"> </a>' },
  ])
})

test('nonempty HTML pairs and code examples are never merged into hidden anchors', () => {
  const tree = {
    type: 'root',
    children: [
      { type: 'html', value: '<a id="ref">' },
      { type: 'text', value: 'visible' },
      { type: 'html', value: '</a>' },
      { type: 'inlineCode', value: '<a id="example"></a>' },
      { type: 'code', value: '<a id="example"></a>' },
    ],
  }
  const original = structuredClone(tree)
  mergeMarkdownAnchors(tree)
  assert.deepEqual(tree, original)
})
