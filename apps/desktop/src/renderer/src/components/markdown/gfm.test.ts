import assert from 'node:assert/strict'
import test from 'node:test'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { GFM_PLUGIN } from './gfm.ts'

test('GFM preserves single-tilde ranges and retains double-tilde deletion', () => {
  const tree = unified()
    .use(remarkParse)
    .use(GFM_PLUGIN[0], GFM_PLUGIN[1])
    .parse('气温 24~33℃，~~旧值~~。')
  const paragraph = tree.children[0]
  assert.equal(paragraph.type, 'paragraph')
  if (paragraph.type !== 'paragraph') return
  const range = paragraph.children[0]
  assert.equal(range?.type, 'text')
  if (range?.type !== 'text') return
  assert.equal(range.value, '气温 24~33℃，')
  const deletion = paragraph.children[1]
  assert.equal(deletion?.type, 'delete')
  if (deletion?.type !== 'delete') return
  const deletedText = deletion.children[0]
  assert.equal(deletedText?.type, 'text')
  if (deletedText?.type !== 'text') return
  assert.equal(deletedText.value, '旧值')
  const suffix = paragraph.children[2]
  assert.equal(suffix?.type, 'text')
  if (suffix?.type !== 'text') return
  assert.equal(suffix.value, '。')
})
