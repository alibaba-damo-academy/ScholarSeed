import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { LiteratureSearchEvent } from '../../contracts/literature.ts'
import { SEARCH_OUTPUT_CLOSE, SEARCH_OUTPUT_OPEN, searchEventText, visibleSearchOutput } from './output.ts'

const event = (seq: number, type: string, data: Record<string, unknown>): LiteratureSearchEvent =>
  ({ schema_version: 1, seq, type, data })

/** 按真实事件流复刻：推理增量（含字面定界符）、整段进度增量、完成事件重发同一段文本、工具事件。 */
const REAL_EVENT_SEQUENCE: LiteratureSearchEvent[] = [
  event(3, 'content.delta', { role: 'reasoning', text: 'I must wrap each progress line' }),
  event(11, 'content.delta', { role: 'reasoning', text: ' in <<< and >>>.' }),
  event(12, 'tool.started', { name: 'web_search' }),
  event(13, 'tool.progress', { tool: 'web_search' }),
  event(14, 'tool.completed', { name: 'web_search' }),
  event(24, 'content.delta', { role: 'assistant', phase: 'commentary', text: '<<<开始检索量子计算文献。>>>\n\n' }),
  event(25, 'content.completed', { role: 'assistant', phase: 'commentary', text: '<<<开始检索量子计算文献。>>>' }),
  event(111, 'content.delta', { role: 'assistant', phase: 'commentary', text: '<<<候选已解析，开始排序。>>>\n\n' }),
  event(112, 'content.completed', { role: 'assistant', phase: 'commentary', text: '<<<候选已解析，开始排序。>>>' }),
  event(161, 'content.delta', { role: 'assistant', phase: 'final_answer', text: '<<<检索完成，共 20 篇。>>>' }),
  event(162, 'content.completed', { role: 'assistant', phase: 'final_answer', text: '<<<检索完成，共 20 篇。>>>' }),
  event(164, 'result.completed', { text: '<<<检索完成，共 20 篇。>>>' })
]

/** 服务端持久化副本的累积口径：只取非推理通道的 content.delta。 */
const SERVER_SIDE_OUTPUT = REAL_EVENT_SEQUENCE
  .filter((item) => item.type === 'content.delta' && item.data.role !== 'reasoning')
  .map((item) => String(item.data.text ?? ''))
  .join('')

const accumulate = (events: readonly LiteratureSearchEvent[]): string =>
  events.reduce((output, item) => `${output}${searchEventText(item)}`, '')

test('只展示定界符之间的内容，过程文本与工具痕迹被丢弃', () => {
  const raw = [
    '我先想一下要检索什么。',
    `${SEARCH_OUTPUT_OPEN}开始检索量子计算相关文献${SEARCH_OUTPUT_CLOSE}`,
    '\n[tool.start] web_search\n',
    `${SEARCH_OUTPUT_OPEN}已拿到 20 篇候选，正在去重${SEARCH_OUTPUT_CLOSE}`,
    'metadata.json written to workspace'
  ].join('')
  assert.equal(visibleSearchOutput(raw), '开始检索量子计算相关文献\n已拿到 20 篇候选，正在去重')
})

test('未闭合的尾段按流式进度先展示已到达部分', () => {
  assert.equal(visibleSearchOutput(`${SEARCH_OUTPUT_OPEN}正在调用检索脚本`), '正在调用检索脚本')
  assert.equal(visibleSearchOutput(`已完成${SEARCH_OUTPUT_OPEN}下一步检索`), '下一步检索')
  assert.equal(visibleSearchOutput(`已完成${SEARCH_OUTPUT_OPEN}${SEARCH_OUTPUT_CLOSE}`), '')
})

test('定界符被拆到相邻流式事件里仍能识别', () => {
  const chunks = ['好的，', `${SEARCH_OUTPUT_OPEN.slice(0, 2)}${SEARCH_OUTPUT_OPEN.slice(2)}正在读取元数据`, `${SEARCH_OUTPUT_CLOSE.slice(0, 1)}${SEARCH_OUTPUT_CLOSE.slice(1)}`]
  let accumulated = ''
  const seen: string[] = []
  for (const chunk of chunks) {
    accumulated += chunk
    seen.push(visibleSearchOutput(accumulated))
  }
  assert.deepEqual(seen, ['', '正在读取元数据', '正在读取元数据'])
})

test('没有定界符或顺序颠倒时不展示任何模型文本', () => {
  assert.equal(visibleSearchOutput(''), '')
  assert.equal(visibleSearchOutput('纯过程输出，没有定界符'), '')
  assert.equal(visibleSearchOutput(`${SEARCH_OUTPUT_CLOSE}先闭合${SEARCH_OUTPUT_OPEN}再开始${SEARCH_OUTPUT_CLOSE}`), '再开始')
})

test('片段首尾空白被裁剪，空片段被丢弃，片段内换行保留', () => {
  const raw = `${SEARCH_OUTPUT_OPEN}\n\n  ${SEARCH_OUTPUT_CLOSE}${SEARCH_OUTPUT_OPEN}第一步\n第二步${SEARCH_OUTPUT_CLOSE}`
  assert.equal(visibleSearchOutput(raw), '第一步\n第二步')
})

test('AI 检索任务展示点消费投影结果，保存结果页仍展示本地摘要', () => {
  const searchSource = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  assert.ok(searchSource.includes('output={visibleSearchOutput(task.output)}'))
  const resultsSource = readFileSync(new URL('./Results.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(resultsSource, /visibleSearchOutput/)
})

test('完成事件重发同一段文本时只累加一次，运行中与结束后内容一致', () => {
  const live = accumulate(REAL_EVENT_SEQUENCE)
  assert.equal(live, '<<<开始检索量子计算文献。>>>\n\n<<<候选已解析，开始排序。>>>\n\n<<<检索完成，共 20 篇。>>>')
  assert.equal(live.match(/<<<开始检索量子计算文献。>>>/g)?.length, 1)
  assert.equal(live.match(/<<<检索完成，共 20 篇。>>>/g)?.length, 1)
  // 服务端持久化的权威副本只由 content.delta 构成；两者一致才不会在流结束替换时跳变。
  assert.equal(live, SERVER_SIDE_OUTPUT)
})

test('运行中的可见进度不因完成事件而重复', () => {
  const growing: string[] = []
  let output = ''
  for (const item of REAL_EVENT_SEQUENCE) {
    output += searchEventText(item)
    growing.push(visibleSearchOutput(output))
  }
  assert.equal(growing.at(-1), '开始检索量子计算文献。\n候选已解析，开始排序。\n检索完成，共 20 篇。')
  // 每一步快照里同一条进度都只出现一次：完成事件重发不会把它变成两份。
  for (const step of growing) {
    const lines = step.split('\n').filter(Boolean)
    assert.equal(new Set(lines).size, lines.length, step)
  }
  assert.equal(growing.filter((step) => step.includes('检索完成，共 20 篇。')).length > 0, true)
})

test('工具事件不再注入标记，缺 text 的增量回落到 delta 字段', () => {
  assert.equal(searchEventText(event(1, 'tool.started', { name: 'web_search' })), '')
  assert.equal(searchEventText(event(2, 'tool.progress', { tool: 'web_search' })), '')
  assert.equal(searchEventText(event(3, 'result.completed', { text: '<<<完成>>>' })), '')
  assert.equal(searchEventText(event(4, 'content.delta', { delta: '<<<增量>>>' })), '<<<增量>>>')
  assert.equal(searchEventText(event(5, 'content.delta', {})), '')
  assert.doesNotMatch(accumulate(REAL_EVENT_SEQUENCE), /\[tool\./)
})

test('推理通道里的字面定界符不会漏成一行垃圾', () => {
  assert.equal(searchEventText(event(11, 'content.delta', { role: 'reasoning', text: ' in <<< and >>>.' })), '')
  // 未打 role 的增量按用户可见处理，避免不打该标记的适配器整段丢内容。
  assert.equal(searchEventText(event(12, 'content.delta', { text: '<<<保留>>>' })), '<<<保留>>>')
  const visible = visibleSearchOutput(accumulate(REAL_EVENT_SEQUENCE))
  assert.equal(visible, '开始检索量子计算文献。\n候选已解析，开始排序。\n检索完成，共 20 篇。')
  assert.doesNotMatch(visible, /^and$/m)
})

test('检索事件累积口径由输出模块统一持有', () => {
  const searchSource = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8')
  assert.ok(searchSource.includes("import { searchEventText, visibleSearchOutput } from './output'"))
  assert.ok(searchSource.includes('output: `${current.output}${searchEventText(event)}`'))
  assert.doesNotMatch(searchSource, /function eventText\(/)
})
