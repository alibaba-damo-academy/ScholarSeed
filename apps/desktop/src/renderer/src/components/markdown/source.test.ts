import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodedBoundaries,
  prepareMarkdownSource,
  sourceLeaf,
  visibleMarkdownText
} from './source.ts'

test('private evidence comments remain offset-stable while rendering and disappear on copy', () => {
  const complete = '回答<!-- scholarseed-ref claim="a" -->正文'
  assert.equal(prepareMarkdownSource(complete), complete)
  assert.equal(visibleMarkdownText(complete), '回答正文')

  const partial = '回答<!-- scholarseed-ref claim="a"'
  const prepared = prepareMarkdownSource(partial)
  assert.equal(prepared.length, partial.length)
  assert.equal(prepared.slice(0, 2), '回答')
  assert.equal(visibleMarkdownText(partial), '回答')
})

test('inline code and escaped Markdown retain exact UTF-16 source boundaries', () => {
  const code = sourceLeaf('`postgres`', 'postgres', 0, 10, 'inline-code')
  assert.ok(code)
  assert.equal(code.startUtf16, 1)
  assert.equal(code.endUtf16, 9)

  const escaped = sourceLeaf('A \\* &amp;', 'A * &', 0, 10)
  assert.ok(escaped)
  assert.ok(encodedBoundaries(escaped))

  const literalEscape = sourceLeaf('`a\\*b`', 'a\\*b', 0, 6, 'inline-code')
  assert.ok(literalEscape)
  assert.equal(literalEscape.startUtf16, 1)
  assert.equal(literalEscape.endUtf16, 5)

  const emojiEntity = sourceLeaf('&#x1F600;', '😀', 0, 9)
  assert.ok(emojiEntity)
  assert.equal(emojiEntity.boundaries[1], null)
})

test('fenced code maps normalized line endings back to the raw source', () => {
  const source = '```ts\r\nconst value = 1\r\n```'
  const leaf = sourceLeaf(source, 'const value = 1\n', 0, source.length, 'fenced-code')
  assert.ok(leaf)
  assert.equal(leaf.startUtf16, 7)
  assert.equal(leaf.endUtf16, 24)
})
