import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import { latestIntersection, pdfPlainText } from './utils.ts'

test('PDF source text preserves words and line endings for language detection', () => {
  const content = {
    items: [
      { str: 'Attention and Language Processing', hasEOL: true },
      { type: 'beginMarkedContent' },
      { str: 'Attention mechanisms ', hasEOL: false },
      { str: 'compare words.', hasEOL: true },
      { type: 'endMarkedContent' },
    ],
  } as TextContent
  assert.equal(
    pdfPlainText(content),
    'Attention and Language Processing\nAttention mechanisms compare words.\n'
  )
})

test('PDF source text retains Chinese and accepts pages without extractable text', () => {
  assert.equal(
    pdfPlainText({ items: [{ str: '注意力机制', hasEOL: true }] } as TextContent),
    '注意力机制\n'
  )
  assert.equal(pdfPlainText({ items: [] }), '')
})

test('PDF visibility uses the latest transition in a batched observer callback', () => {
  assert.equal(
    latestIntersection([
      { time: 10, isIntersecting: false },
      { time: 20, isIntersecting: true },
    ])?.isIntersecting,
    true
  )
  assert.equal(
    latestIntersection([
      { time: 10, isIntersecting: true },
      { time: 20, isIntersecting: false },
    ])?.isIntersecting,
    false
  )
})

test('PDF visibility selects the newest timestamp and preserves arrival order on ties', () => {
  assert.equal(
    latestIntersection([
      { time: 20, isIntersecting: true },
      { time: 10, isIntersecting: false },
    ])?.isIntersecting,
    true
  )
  assert.equal(
    latestIntersection([
      { time: 20, isIntersecting: false },
      { time: 20, isIntersecting: true },
    ])?.isIntersecting,
    true
  )
})

test('PDF visibility handles empty and single-entry callbacks', () => {
  assert.equal(latestIntersection([]), undefined)
  assert.equal(latestIntersection([{ time: 10, isIntersecting: true }])?.isIntersecting, true)
})
