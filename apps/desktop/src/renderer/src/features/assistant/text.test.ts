import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../../../localization/locales/en/assistant.json' with { type: 'json' }
import { feedback, renderFeedback } from '../../contracts/feedback.ts'
import { candidateLabel, candidateHint, sessionTimeLabel } from './text.ts'
import type { AssistantContextCandidate } from '../../contracts/assistant'

// 与 localization/format.ts 的 createFormatters 同形, 但保留显式 locale 以便逐语言断言。
// format.ts 内部用无扩展名导入, node ESM 解析不了, 所以这里不进真实模块。
const formatters = (locale: string) => ({
  date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value),
  relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => new Intl.RelativeTimeFormat(locale, options).format(value, unit),
  number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
  bytes: (value: number) => String(value)
})

test('source and candidate presentation changes language without changing source identity', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources: { zh: { assistant: zh }, en: { assistant: en } } })
  const label = feedback('assistant', 'sources.sessions')
  const candidate: AssistantContextCandidate = { kind: 'session', source_id: 'session-id', label: '未命名对话', labelFallback: 'untitledSession', hintKey: 'wholeSession', origin: 'explicit' }
  const original = JSON.stringify(candidate)
  const t = locale.getFixedT(null, 'assistant')
  assert.equal(renderFeedback(locale, label), '任务')
  assert.equal(candidateLabel(candidate, t), '未命名任务')
  await locale.changeLanguage('en')
  assert.equal(renderFeedback(locale, label), 'Tasks')
  assert.equal(candidateLabel(candidate, t), 'Untitled task')
  assert.equal(candidateHint(candidate, t), 'Reference the entire task context')
  assert.equal(JSON.stringify(candidate), original)
  assert.equal(candidateLabel({ ...candidate, label: '用户会话', labelFallback: undefined }, t), '用户会话')
})

test('session time label follows the preference language and stays empty without mtime', () => {
  // 历史对话浮层右侧的更新时间：真实接口只给 Unix 秒，给不出就不显示这一列。
  // 用本地时区构造时间戳, 避免测试机时区影响断言。
  const timestamp = new Date(2026, 8, 17, 19, 38).getTime() / 1_000

  assert.equal(sessionTimeLabel(timestamp, formatters('zh-CN')), '9/17 19:38')
  assert.equal(sessionTimeLabel(timestamp, formatters('en-US')), '9/17, 19:38')
  assert.equal(sessionTimeLabel(undefined, formatters('zh-CN')), '')
  assert.equal(sessionTimeLabel(0, formatters('zh-CN')), '')
})
