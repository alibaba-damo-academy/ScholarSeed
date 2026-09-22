import assert from 'node:assert/strict'
import test from 'node:test'

import type { LiteratureSummary } from '../../contracts/literature'
import { openedLiteratureIconKind, openedLiteratureLabel } from './recent.ts'

// 与 localization/format.ts 的 createFormatters 同形, 但保留显式 locale 以便逐语言断言。
const formatters = (locale: string) => ({
  date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value),
  relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => new Intl.RelativeTimeFormat(locale, options).format(value, unit),
  number: (value: number) => String(value)
})

const NOW = new Date(2026, 8, 16, 9, 0, 0)

test('current-year opens hide the year and keep the time', () => {
  const opened = new Date(2026, 8, 15, 15, 30).getTime()
  assert.equal(openedLiteratureLabel(opened, formatters('zh-CN'), NOW), '9月15日 15:30')
  assert.equal(openedLiteratureLabel(opened, formatters('en-US'), NOW), 'Sep 15 15:30')
})

test('other-year opens carry the year and drop the time', () => {
  const opened = new Date(2025, 8, 15, 15, 30).getTime()
  assert.equal(openedLiteratureLabel(opened, formatters('zh-CN'), NOW), '2025年9月15日')
  assert.equal(openedLiteratureLabel(opened, formatters('en-US'), NOW), 'Sep 15, 2025')
})

test('unparsable open timestamps render empty', () => {
  assert.equal(openedLiteratureLabel(Number.NaN, formatters('zh-CN'), NOW), '')
})

const summary = (attachment: LiteratureSummary['primary_attachment']): LiteratureSummary => ({
  id: 'lit',
  item_type: 'article',
  bib_type: 'article',
  title: '低仰角链路湍流测量方法',
  creators_display: '',
  publication_display: '',
  year: null,
  published_date: null,
  created_at: '',
  updated_at: '',
  last_read_at: null,
  read_progress: 0,
  is_unread: true,
  primary_attachment: attachment,
  attachments: [],
  collections: [],
  project_collections: [],
  tags: [],
  projects: [],
  version: 1
})

const attachment = (
  kind: string,
  name: string,
  media_type: string,
  availability: NonNullable<LiteratureSummary['primary_attachment']>['availability'] = 'available'
): NonNullable<LiteratureSummary['primary_attachment']> => ({
  id: 'att',
  name,
  kind,
  availability,
  role: 'primary',
  media_type,
  annotation_count: 0,
  record_target: { owner: 'literature_attachment', scope_id: 'lit', subject_id: 'att' }
})

test('row icon kinds follow the primary attachment kind', () => {
  assert.equal(openedLiteratureIconKind(summary(attachment('pdf', 'paper.pdf', 'application/pdf'))), 'pdf')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'notes.md', 'text/markdown'))), 'txt')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'notes.txt', 'text/plain'))), 'txt')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'scan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))), 'word')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))), 'xls')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'))), 'ppt')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'page.html', 'text/html'))), 'html')
  assert.equal(openedLiteratureIconKind(summary(attachment('image', 'fig.png', 'image/png'))), 'img')
  assert.equal(openedLiteratureIconKind(summary(attachment('video', 'clip.mp4', 'video/mp4'))), 'video')
  assert.equal(openedLiteratureIconKind(summary(attachment('audio', 'talk.mp3', 'audio/mpeg'))), 'music')
  assert.equal(openedLiteratureIconKind(summary(attachment('archive', 'data.zip', 'application/zip'))), 'zip')
  assert.equal(openedLiteratureIconKind(summary(attachment('code', 'model.py', 'text/x-python'))), 'tsx')
  assert.equal(openedLiteratureIconKind(summary(attachment('file', 'mystery.bin', 'application/octet-stream'))), 'unknown')
  assert.equal(openedLiteratureIconKind(summary(null)), 'unknown')
  // 附件行还在、文件已经不在时, 不能再显示 PDF 图标。
  assert.equal(
    openedLiteratureIconKind(summary(attachment('pdf', 'paper.pdf', 'application/pdf', 'missing'))),
    'unknown'
  )
})
