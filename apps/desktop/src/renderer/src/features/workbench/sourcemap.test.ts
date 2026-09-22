import assert from 'node:assert/strict'
import test from 'node:test'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { GFM_PLUGIN } from '../../components/markdown/gfm.ts'
import { markdownSourceRange, type MarkdownSyntaxNode } from './mapping.ts'
import { normalizeMathSource, restoreSourcePositions } from './mathematics.ts'

const parser = unified().use(remarkParse).use(GFM_PLUGIN[0], GFM_PLUGIN[1]).use(remarkMath)

/** Rendered text as ProseMirror exposes it: text and atom values, no block separators. */
function select(source: string, rendered: string, selected: string, occurrence = 0): string | null {
  let from = -1
  for (let index = 0; index <= occurrence; index++) from = rendered.indexOf(selected, from + 1)
  assert.ok(from >= 0, `rendered text contains ${selected}`)
  const tree = parser.parse(source) as MarkdownSyntaxNode
  const range = markdownSourceRange(source, tree, rendered, from, from + selected.length)
  return range?.text ?? null
}

test('single-block selection keeps its exact source slice and repeated text occurrence', () => {
  const source = '# 标题\n\n重复 文本。\n\n重复 文本。'
  const rendered = '标题重复 文本。重复 文本。'
  assert.equal(select(source, rendered, '文本'), '文本')
  const tree = parser.parse(source) as MarkdownSyntaxNode
  const second = rendered.lastIndexOf('文本')
  const range = markdownSourceRange(source, tree, rendered, second, second + 2)
  assert.ok(range)
  assert.equal(range.start, source.lastIndexOf('文本'))
})

test('numeric ranges retain literal single tildes in source mappings', () => {
  const source = '气温 24~33℃，~~旧值~~'
  const rendered = '气温 24~33℃，旧值'
  assert.equal(select(source, rendered, '24~33℃'), '24~33℃')
  assert.equal(select(source, rendered, '旧值'), '~~旧值~~')
})

test('selection across heading and paragraph maps to the contiguous Markdown source', () => {
  const source = '# 研究背景\n\n温度升高导致效率下降。\n\n第二段内容。'
  const rendered = '研究背景温度升高导致效率下降。第二段内容。'
  assert.equal(select(source, rendered, '背景温度升高'), '# 背景\n\n温度升高')
  assert.equal(select(source, rendered, '研究背景温度'), '# 研究背景\n\n温度')
  assert.equal(select(source, rendered, '下降。第二段'), '下降。\n\n第二段')
})

test('inline code, emphasis and escapes include whole markup at selection edges', () => {
  const source = '调用 `run()` 后 **完成** \\* 结束'
  const rendered = '调用 run() 后 完成 * 结束'
  assert.equal(select(source, rendered, '调用 run() 后'), '调用 `run()` 后')
  assert.equal(select(source, rendered, 'run'), '`run`')
  assert.equal(select(source, rendered, '后 完成'), '后 **完成**')
  assert.equal(select(source, rendered, '完成 * 结束'), '**完成** \\* 结束')
})

test('selection into and inside fenced code blocks maps code content', () => {
  const source = '说明文字\n\n```python\nprint("a")\nreturn 1\n```\n\n结尾'
  const rendered = '说明文字print("a")\nreturn 1结尾'
  assert.equal(select(source, rendered, '文字print'), '文字\n\n```python\nprint\n```')
  assert.equal(select(source, rendered, 'return'), '```python\nreturn\n```')
  assert.equal(select(source, rendered, 'print("a")\nreturn 1'), '```python\nprint("a")\nreturn 1\n```')
  assert.equal(select(source, rendered, '1结尾'), '```python\n1\n```\n\n结尾')
})

test('lists, blockquotes, hard breaks and inline math remain aligned', () => {
  const source = '- 第一项\n- 第二项\n\n> 引用一\n> 引用二\n\n换行  \n下一行 $x^2$ 公式'
  const rendered = '第一项第二项引用一\n引用二换行\n下一行 x^2 公式'
  assert.equal(select(source, rendered, '第一项'), '- 第一项')
  assert.equal(select(source, rendered, '第二项'), '- 第二项')
  assert.equal(select(source, rendered, '一项第二'), '- 一项\n- 第二')
  assert.equal(select(source, rendered, '引用一\n引用二'), '> 引用一\n> 引用二')
  assert.equal(select(source, rendered, '换行\n下一行'), '换行  \n下一行')
  assert.equal(select(source, rendered, '行 x^2 公'), '行 $x^2$ 公')
})

test('unalignable rendered text fails closed instead of guessing', () => {
  const source = '甲乙丙'
  const tree = parser.parse(source) as MarkdownSyntaxNode
  assert.equal(markdownSourceRange(source, tree, '甲丁丙', 0, 3), null)
  assert.equal(markdownSourceRange(source, tree, '甲乙丙', 2, 2), null)
})

test('math delimiter normalization reports positions in original source coordinates', () => {
  const source = '前 \\(x\\) 后 **粗**'
  const normalized = normalizeMathSource(source, parser.parse(source) as never)
  assert.equal(normalized.text, '前 $x$ 后 **粗**')
  const tree = parser.parse(normalized.text) as MarkdownSyntaxNode
  restoreSourcePositions(tree as never, source, normalized.origins)
  const rendered = '前 x 后 粗'
  const from = rendered.indexOf('后')
  const range = markdownSourceRange(source, tree, rendered, from, rendered.length)
  assert.ok(range)
  assert.equal(range.text, '后 **粗**')
})

test('completed Markdown quotes retain only selected content and source-backed control markers', () => {
  const source = '**first second** and `run()`'
  const rendered = 'first second and run()'
  const tree = parser.parse(source) as MarkdownSyntaxNode
  const from = rendered.indexOf('second')
  const strong = markdownSourceRange(source, tree, rendered, from, from + 'second'.length)
  assert.ok(strong)
  assert.equal(strong.text, '**second**')
  assert.deepEqual(strong.segments.map(segment => source.slice(segment.start, segment.end)), ['**', 'second**'])

  const codeFrom = rendered.indexOf('run')
  const code = markdownSourceRange(source, tree, rendered, codeFrom, codeFrom + 'run'.length)
  assert.ok(code)
  assert.equal(code.text, '`run`')
  assert.deepEqual(code.segments.map(segment => source.slice(segment.start, segment.end)), ['`run', '`'])
})
