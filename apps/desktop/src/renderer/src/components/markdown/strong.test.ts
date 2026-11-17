import assert from 'node:assert/strict'
import test from 'node:test'
import { strongSegments } from './strong.ts'

test('strong segments preserve source layout around bold text in copied lists', () => {
  assert.deepEqual(strongSegments('说明：\n- **查找文献** — 阅读\n- __研究想法__'), [
    { text: '说明：\n- ' },
    { text: '查找文献', strong: true },
    { text: ' — 阅读\n- ' },
    { text: '研究想法', strong: true },
  ])
  assert.deepEqual(strongSegments('（**中文加粗**）'), [
    { text: '（' },
    { text: '中文加粗', strong: true },
    { text: '）' },
  ])
})

test('literal stars, escaped markers, code and HTML remain literal', () => {
  for (const source of [
    '普通文字 2 * 3，*原样*，未闭合 **标记',
    '\\**不加粗**',
    '`**代码原文**`',
    '```text\n**代码原文**\n```',
    '<img src="https://example.com/image.png" onerror="alert(1)">',
    'https://example.com/query?value=**literal**',
  ]) {
    assert.deepEqual(strongSegments(source), [{ text: source }], source)
  }
})

test('bold links retain their complete source and mixed code stays literal', () => {
  assert.deepEqual(strongSegments('`**原样**` 与 **https://example.com/a?q=1&v=%20#part**'), [
    { text: '`**原样**` 与 ' },
    { text: 'https://example.com/a?q=1&v=%20#part', strong: true },
  ])
})

test('unrelated markers on different source lines remain literal', () => {
  const source = '未闭合 **。\n代码：`**代码原文**`；转义：\\**不加粗**。'
  assert.deepEqual(strongSegments(source), [{ text: source }])
})
