import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownSummary } from '../../../../markdown/summary.ts'

test('summaries use the same CJK and literal HTML rules as the answer', () => {
  assert.equal(markdownSummary('中文**「重点」**继续'), '中文「重点」继续')
  assert.equal(markdownSummary('<b>literal</b>'), '<b>literal</b>')
})

test('literal markers, escapes, math and code are not stripped as formatting', () => {
  for (const [source, expected] of [
    ['**This turn**', 'This turn'],
    ['*emphasis* and ~~removed~~', 'emphasis and removed'],
    ['\\*\\*literal\\*\\*', '**literal**'],
    ['`**literal**`', '**literal**'],
    ['2 * 3, snake_case, C#, #tag, **unclosed', '2 * 3, snake_case, C#, #tag, **unclosed'],
    ['~literal~ and ~~removed~~', '~literal~ and removed'],
    ['$a_b*c_d$ and $5 and $10', 'a_b*c_d and $5 and $10'],
    ['`<!-- scholarseed-ref example -->`', '<!-- scholarseed-ref example -->'],
  ])
    assert.equal(markdownSummary(source), expected, source)
})

test('summaries flatten Markdown formatting while preserving readable text', () => {
  assert.equal(
    markdownSummary(
      '# 标题\n\n**粗体**与*斜体*、~~删除~~和`code`\n\n- [链接](https://example.com)\n- ![图片说明](image.png)'
    ),
    '标题 粗体与斜体、删除和code 链接 图片说明'
  )
  assert.equal(
    markdownSummary('> 引用\n\n```js\nconst value = 2 * 3\n```'),
    '引用 const value = 2 * 3'
  )
})

test('summaries preserve literal punctuation and decode entities without exposing metadata', () => {
  assert.equal(
    markdownSummary(
      '2 * 3，snake_case，\\*字面星号\\* &amp; 内容<!-- scholarseed-ref claim="x" -->'
    ),
    '2 * 3，snake_case，*字面星号* & 内容'
  )
  assert.equal(markdownSummary('<!-- scholarseed-ref claim="pending"'), '')
  assert.equal(markdownSummary(''), '')
})

test('tables, task lists and reference links become text rather than markup', () => {
  assert.equal(
    markdownSummary(
      '| A | B |\n| --- | --- |\n| C | D |\n\n- [x] 完成\n\n[说明][ref]\n\n[ref]: https://example.com'
    ),
    'A B C D 完成 说明'
  )
})
