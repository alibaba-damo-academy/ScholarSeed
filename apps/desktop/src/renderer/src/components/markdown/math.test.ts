import assert from 'node:assert/strict'
import test from 'node:test'
import remarkParse from 'remark-parse'
import type { Root } from 'hast'
import { unified } from 'unified'

import { prepareMathSource } from './source.ts'
import { FORMULA_SOURCE, rehypeAnswerMath, remarkAnswerMath } from './math.ts'

const parse = (source: string) =>
  unified().use(remarkParse).use(remarkAnswerMath).parse(prepareMathSource(source))

test('block math keeps its source and position while ordinary code and inline math stay on their original path', () => {
  const block: Root['children'][number] = {
    type: 'element',
    tagName: 'pre',
    properties: {},
    position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 3, column: 3, offset: 12 } },
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-math', 'math-display'] },
        children: [{ type: 'text', value: '\\frac{x}{y}\n' }],
      },
    ],
  }
  const inline: Root['children'][number] = {
    type: 'element',
    tagName: 'code',
    properties: { className: ['math-inline'] },
    children: [{ type: 'text', value: 'x^2' }],
  }
  const code: Root['children'][number] = {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-text'] },
        children: [{ type: 'text', value: '$$ not math $$\n' }],
      },
    ],
  }
  const originalInline = structuredClone(inline)
  const originalCode = structuredClone(code)
  const position = structuredClone(block.position)
  const tree: Root = { type: 'root', children: [block, inline, code] }
  rehypeAnswerMath()(tree)
  assert.equal(block.tagName, 'div')
  assert.equal(block.properties[FORMULA_SOURCE], '\\frac{x}{y}')
  assert.deepEqual(block.children, [])
  assert.deepEqual(block.position, position)
  assert.deepEqual(inline, originalInline)
  assert.deepEqual(code, originalCode)
})

test('currency ranges preserve bold text, citation links and source offsets', () => {
  const source =
    '52周区间 **$16.60 – $71.48**，目标价 $31[1](https://example.com/source)，另一个目标价 $40。'
  const paragraph = parse(source).children[0]
  assert.equal(paragraph.type, 'paragraph')
  if (paragraph.type !== 'paragraph') return
  assert.equal(
    paragraph.children.some((node) => node.type === 'inlineMath'),
    false
  )
  const strong = paragraph.children.find((node) => node.type === 'strong')
  assert.deepEqual(
    strong?.children.map((node) => (node.type === 'text' ? node.value : '')),
    ['$16.60 – $71.48']
  )
  const link = paragraph.children.find((node) => node.type === 'link')
  assert.equal(link?.url, 'https://example.com/source')
  assert.equal(
    source.slice(link?.position?.start.offset, link?.position?.end.offset),
    '[1](https://example.com/source)'
  )
})

test('signed, decimal and comma separated dollar amounts remain prose', () => {
  for (const source of [
    '营收 $1,046M，同比 +$48.33M，净利 -$0.12。',
    '$20 and $30',
    '$16.60–$71.48',
    '价格 $20 and $x^2$ 是公式',
  ]) {
    const paragraph = parse(source).children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') continue
    const formulas = paragraph.children.filter((node) => node.type === 'inlineMath')
    assert.deepEqual(
      formulas.map((node) => node.value),
      source.includes('x^2') ? ['x^2'] : []
    )
  }
})

test('real single-dollar, double-dollar and TeX formulas retain math support', () => {
  const tree = parse('公式 $x^2$、$2x+1$、$2$、$$a+b$$、\\(y^2\\)。\n\n$$\nz^2\n$$')
  const paragraph = tree.children[0]
  assert.equal(paragraph.type, 'paragraph')
  if (paragraph.type !== 'paragraph') return
  assert.deepEqual(
    paragraph.children.filter((node) => node.type === 'inlineMath').map((node) => node.value),
    ['x^2', '2x+1', '2', 'a+b', 'y^2']
  )
  assert.equal(tree.children[1].type, 'math')
})

test('escaped dollars and code remain untouched', () => {
  const tree = parse('\\$20 and \\$30; `$20 $30`\n\n```text\n$20 $30\n```')
  const paragraph = tree.children[0]
  assert.equal(paragraph.type, 'paragraph')
  if (paragraph.type !== 'paragraph') return
  assert.equal(
    paragraph.children.some((node) => node.type === 'inlineMath'),
    false
  )
  assert.equal(paragraph.children.find((node) => node.type === 'inlineCode')?.value, '$20 $30')
  const code = tree.children[1]
  assert.equal(code.type, 'code')
  if (code.type === 'code') assert.equal(code.value, '$20 $30')
})
