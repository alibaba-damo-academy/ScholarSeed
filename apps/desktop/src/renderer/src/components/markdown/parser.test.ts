import assert from 'node:assert/strict'
import test from 'node:test'
import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified, type Processor } from 'unified'

import { createMarkdownParseCache } from './parser.ts'
import { remarkAnswerMath } from './math.ts'

test('unchanged Markdown reuses parsing across processors without reusing mutated trees', () => {
  let parses = 0
  const cache = createMarkdownParseCache()
  function observeParser(this: Processor): void {
    const parse = this.parser!
    this.parser = (document, file) => {
      parses += 1
      return parse(document, file)
    }
  }
  const processor = () => unified().use(remarkParse).use(observeParser).use(cache)
  const source = '历史消息 **正文** 😀 [来源](resources/report.md)'
  const first = processor().parse(source)
  const expected = structuredClone(first)
  first.children.length = 0
  const second = processor().parse(source)
  assert.equal(parses, 1)
  assert.deepEqual(second, expected)
  assert.notEqual(second, first)
  second.children[0].position!.start.offset = 99
  assert.deepEqual(processor().parse(source), expected)
  assert.equal(parses, 1)

  processor().parse(`${source} streamed text`)
  assert.equal(parses, 2)
  processor().parse(source)
  assert.equal(parses, 3)
})

test('cached syntax still runs current transforms on every render', () => {
  const cache = createMarkdownParseCache()
  const source = '**unchanged**'
  const render = (revision: number) => {
    const processor = unified()
      .use(remarkParse)
      .use(cache)
      .use(() => (tree: Root) => {
        tree.children.push({
          type: 'paragraph',
          children: [{ type: 'text', value: String(revision) }],
        })
      })
    return processor.runSync(processor.parse(source))
  }
  assert.deepEqual(render(1).children.at(-1), {
    type: 'paragraph',
    children: [{ type: 'text', value: '1' }],
  })
  assert.deepEqual(render(2).children.at(-1), {
    type: 'paragraph',
    children: [{ type: 'text', value: '2' }],
  })
})

test('parser caches are isolated between messages and math configurations', () => {
  const plainCache = createMarkdownParseCache()
  const mathCache = createMarkdownParseCache()
  const source = '$x^2$'
  const plain = () => unified().use(remarkParse).use(plainCache).parse(source)
  const math = () => unified().use(remarkParse).use(remarkAnswerMath).use(mathCache).parse(source)
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const plainParagraph = plain().children[0]
    const mathParagraph = math().children[0]
    assert.equal(plainParagraph.type, 'paragraph')
    assert.equal(mathParagraph.type, 'paragraph')
    if (plainParagraph.type !== 'paragraph' || mathParagraph.type !== 'paragraph') return
    assert.equal(plainParagraph.children[0].type, 'text')
    assert.equal(mathParagraph.children[0].type, 'inlineMath')
  }
})
