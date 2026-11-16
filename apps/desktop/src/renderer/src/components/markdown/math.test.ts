import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkParse from 'remark-parse'
import type { Root } from 'hast'
import { unified } from 'unified'

import { prepareMathSource } from '../../../../markdown/source.ts'
import {
  FORMULA_SOURCE,
  INLINE_FORMULA_SOURCE,
  rehypeAnswerMath,
  remarkAnswerMath,
} from '../../../../markdown/math.ts'

const parse = (source: string) =>
  unified().use(remarkParse).use(remarkAnswerMath).parse(prepareMathSource(source))

const renderMath = (source: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: prepareMathSource(source),
      remarkPlugins: [remarkBreaks, remarkAnswerMath],
      rehypePlugins: [[rehypeAnswerMath, source]],
    })
  )

test('double-dollar formulas on their own lines split a paragraph without blank lines', () => {
  const source = '**MSE**\r\n$$x^2$$  \r\n  $$y^2$$\r\n结果 [1](https://example.com/source)'
  const html = renderMath(source)
  assert.equal(
    html,
    '<p><strong>MSE</strong></p><div data-conversation-formula="x^2"></div><div data-conversation-formula="y^2"></div><p>结果 <a href="https://example.com/source">1</a></p>'
  )
})

test('prose formulas, escaped delimiters and code are not promoted', () => {
  const html = renderMath(
    '正文 $$x^2$$\n$$y^2$$ 后接正文\n$z^2$\n\\$\\$a\\$\\$\n\n`$$b$$`\n\n```text\n$$c$$\n```'
  )
  assert.equal((html.match(/data-conversation-inline-formula/g) ?? []).length, 3)
  assert.doesNotMatch(html, /data-conversation-formula=/)
  assert.match(html, /\$\$a\$\$/)
  assert.match(html, /<code>\$\$b\$\$<\/code>/)
  assert.match(html, /<pre><code class="language-text">\$\$c\$\$/)
})

test('splitting keeps adjacent inline math inline and preserves formula offsets', () => {
  const source = '$x$\n$$y$$\n\\(z\\)'
  let formulaSource: string | undefined
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: prepareMathSource(source),
      remarkPlugins: [remarkBreaks, remarkAnswerMath],
      rehypePlugins: [[rehypeAnswerMath, source]],
      components: {
        div: ({ node }) => {
          formulaSource = source.slice(node?.position?.start.offset, node?.position?.end.offset)
          return null
        },
      },
    })
  )
  assert.equal(formulaSource, '$$y$$')
  assert.match(html, /<p><span class="" data-conversation-inline-formula="x"><\/span><\/p>/)
  assert.match(html, /<p><span class="" data-conversation-inline-formula="z"><\/span><\/p>/)
})

test('a standalone single-line formula uses the interactive block renderer', () => {
  const paragraph: Root['children'][number] = {
    type: 'element',
    tagName: 'p',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-math', 'math-inline'] },
        children: [{ type: 'text', value: 'F=kx' }],
      },
    ],
  }
  rehypeAnswerMath()({ type: 'root', children: [paragraph] })
  assert.equal(paragraph.tagName, 'div')
  assert.equal(paragraph.properties[FORMULA_SOURCE], 'F=kx')
  assert.deepEqual(paragraph.children, [])
})

test('a formula inside prose remains inline', () => {
  const paragraph: Root['children'][number] = {
    type: 'element',
    tagName: 'p',
    properties: {},
    children: [
      { type: 'text', value: 'Hooke law: ' },
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['math-inline'] },
        children: [{ type: 'text', value: 'F=kx' }],
      },
    ],
  }
  rehypeAnswerMath()({ type: 'root', children: [paragraph] })
  assert.equal(paragraph.tagName, 'p')
  const formula = paragraph.children[1]
  assert.equal(formula.type, 'element')
  if (formula.type === 'element') {
    assert.equal(formula.tagName, 'span')
    assert.equal(formula.properties[INLINE_FORMULA_SOURCE], 'F=kx')
  }
})

test('block and inline math retain their source for safe renderers while ordinary code stays untouched', () => {
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
  assert.equal(inline.tagName, 'span')
  assert.equal(inline.properties[INLINE_FORMULA_SOURCE], 'x^2')
  assert.deepEqual(inline.properties.className, [])
  assert.deepEqual(inline.position, originalInline.position)
  assert.deepEqual(inline.children, [])
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
