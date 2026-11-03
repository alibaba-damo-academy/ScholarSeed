import assert from 'node:assert/strict'
import test from 'node:test'
import type { Element, Root } from 'hast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { VFile } from 'vfile'
import { GFM_PLUGIN } from './gfm.ts'
import { CITATION_MARKER } from './citations.ts'
import {
  rehypeTabulation,
  remarkTabulation,
  TABLE_COPY,
  TABLE_INVALID,
  TABLE_NUMERIC,
} from './tabulation.ts'

function cell(value: string, citation = false): Element {
  return {
    type: 'element',
    tagName: 'td',
    properties: {},
    children: [
      { type: 'text', value },
      ...(citation
        ? [
            {
              type: 'element' as const,
              tagName: 'sup',
              properties: { [CITATION_MARKER]: true },
              children: [{ type: 'text' as const, value: '[1]' }],
            },
          ]
        : []),
    ],
  }
}

test('table metadata preserves quoted TSV, units, missing values and citations without mutating cells', () => {
  const rows = [
    [cell('方法'), cell('准确率 (%)'), cell('延迟 (ms)'), cell('说明')],
    [cell('A'), cell('86.5', true), cell('—'), cell('含"引号"\t与\n换行')],
    [cell('B'), cell(''), cell('未报告'), cell('原始文本')],
  ]
  const original = rows.map((row) => row.map((item) => structuredClone(item.children)))
  const table: Element = {
    type: 'element',
    tagName: 'table',
    properties: {},
    children: rows.map((children) => ({
      type: 'element',
      tagName: 'tr',
      properties: {},
      children,
    })),
  }
  const root: Root = { type: 'root', children: [table] }
  rehypeTabulation()(root)
  assert.equal(
    table.properties[TABLE_COPY],
    '方法\t准确率 (%)\t延迟 (ms)\t说明\nA\t86.5[1]\t—\t"含""引号""\t与\n换行"\nB\t\t未报告\t原始文本'
  )
  for (const row of rows) {
    assert.equal(row[1].properties[TABLE_NUMERIC], true)
    assert.equal(row[2].properties[TABLE_NUMERIC], undefined)
    assert.equal(row[0].properties[TABLE_NUMERIC], undefined)
  }
  assert.deepEqual(
    rows.map((row) => row.map((item) => item.children)),
    original
  )
})

test('incomplete table fallback preserves original source and leaves normal prose, code and parsed tables alone', async () => {
  const processor = unified()
    .use(remarkParse)
    .use(GFM_PLUGIN[0], GFM_PLUGIN[1])
    .use(remarkTabulation)
  const malformed = '| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |'
  const parsed = await processor.run(processor.parse(malformed), new VFile({ value: malformed }))
  assert.equal(parsed.children[0].data?.hProperties?.[TABLE_INVALID], malformed)
  for (const source of [
    'A | B\nordinary prose',
    '```text\n' + malformed + '\n```',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
  ]) {
    const tree = processor.parse(source)
    const original = structuredClone(tree)
    await processor.run(tree, new VFile({ value: source }))
    assert.deepEqual(tree, original)
  }
})
