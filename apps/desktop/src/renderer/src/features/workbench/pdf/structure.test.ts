import assert from 'node:assert/strict'
import test from 'node:test'
import { translationOutline } from './structure.ts'
import type { TranslationSentence } from './analysis.ts'

function sentence(source: string, paragraph: string, level?: number): TranslationSentence {
  return {
    source_text: source,
    translated_text: source,
    located: true,
    source_id: source,
    paragraph_id: paragraph,
    paragraph_start: true,
    heading: level !== undefined,
    heading_level: level,
  }
}

test('paragraphs and nested sections retain source identities during streaming', () => {
  const source = [
    sentence('Chapter', 'heading', 1),
    sentence('First.', 'paragraph'),
    sentence('Second.', 'paragraph'),
    sentence('Detail', 'detail', 2),
    sentence('Body.', 'body'),
    sentence('Next', 'next', 1),
  ]
  const tree = translationOutline(source)
  assert.equal(tree.length, 2)
  assert.equal(tree[0].id, 'heading')
  assert.equal(tree[0].children[0].sentences.length, 2)
  assert.equal(tree[0].children[1].id, 'detail')
  assert.equal(tree[0].children[1].children[0].id, 'body')
  assert.equal(translationOutline(source.slice(0, 2))[0].id, tree[0].id)
})

test('legacy headings fold without merging distinct paragraph starts or mutating saved results', () => {
  const source: TranslationSentence[] = [
    { source_text: 'Heading', translated_text: '标题', located: true, heading: true },
    { source_text: 'One.', translated_text: '一。', located: true, paragraph_start: true },
    { source_text: 'Two.', translated_text: '二。', located: true },
    { source_text: 'Three.', translated_text: '三。', located: true, paragraph_start: true },
  ]
  const before = JSON.stringify(source)
  const tree = translationOutline(source)
  assert.equal(tree[0].children.length, 2)
  assert.equal(tree[0].children[0].sentences.length, 2)
  assert.equal(JSON.stringify(source), before)
})
