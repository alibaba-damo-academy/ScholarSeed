import type { createFormatters } from '../../../../localization/format'
import {
  isAttachmentAvailable,
  type LiteratureAttachmentSummary,
  type LiteratureSummary,
} from '../../contracts/literature.ts'

/** 首页「最近打开」只展示三条，更多历史回文献库看。 */
export const RECENT_LITERATURE_DISPLAY_LIMIT = 3

const TEXT_ICON_KIND = 'txt'

/** 比展示数多取几条：条目被删除、或没有可打开的附件时仍能补齐三行。 */
export const RECENT_LITERATURE_RESOLVE_LIMIT = 5

const GLOBAL_LITERATURE_PROJECT_ID = ''

interface RecentLiteratureActions {
  openLiteratureItem: (id: string, projectId: string) => Promise<boolean>
  openLiteratureAttachment: (
    id: string,
    attachmentId?: string,
    page?: number,
    options?: { projectId?: string | null }
  ) => Promise<boolean>
}

export async function openRecentLiterature(
  actions: RecentLiteratureActions,
  id: string
): Promise<'opened' | 'item_unavailable' | 'attachment_unavailable'> {
  if (!(await actions.openLiteratureItem(id, GLOBAL_LITERATURE_PROJECT_ID)))
    return 'item_unavailable'
  return (await actions.openLiteratureAttachment(id, undefined, undefined, {
    projectId: GLOBAL_LITERATURE_PROJECT_ID,
  }))
    ? 'opened'
    : 'attachment_unavailable'
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text'])

/** 与 renderer/src/assets 下 icon-<kind>.png 系列一一对应；映射留在测试面之外。 */
export type RecentLiteratureIconKind =
  | 'pdf'
  | 'word'
  | 'xls'
  | 'ppt'
  | 'txt'
  | 'html'
  | 'img'
  | 'video'
  | 'music'
  | 'zip'
  | 'tsx'
  | 'unknown'

const ICON_KIND_BY_EXTENSION: Record<string, RecentLiteratureIconKind> = {
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  xls: 'xls',
  xlsx: 'xls',
  csv: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
  md: 'txt',
  markdown: 'txt',
  txt: 'txt',
  text: TEXT_ICON_KIND,
  html: 'html',
  htm: 'html',
  png: 'img',
  jpg: 'img',
  jpeg: 'img',
  gif: 'img',
  webp: 'img',
  svg: 'img',
  bmp: 'img',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  mp3: 'music',
  wav: 'music',
  flac: 'music',
  m4a: 'music',
  ogg: 'music',
  zip: 'zip',
  rar: 'zip',
  '7z': 'zip',
  tar: 'zip',
  gz: 'zip',
  py: 'tsx',
  js: 'tsx',
  ts: 'tsx',
  tsx: 'tsx',
  jsx: 'tsx',
  json: 'tsx',
  java: 'tsx',
  c: 'tsx',
  cpp: 'tsx',
  go: 'tsx',
  rs: 'tsx',
}

/**
 * 最近打开行的时间标签：当年只到月日并带时分，跨年才带年份（且不重复带时分）。
 */
export function openedLiteratureLabel(
  openedAt: number,
  format: ReturnType<typeof createFormatters>,
  now = new Date()
): string {
  const date = new Date(openedAt)
  if (Number.isNaN(date.getTime())) return ''
  if (date.getFullYear() === now.getFullYear()) {
    return `${format.date(date, { month: 'short', day: 'numeric' })} ${format.date(date, { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  return format.date(date, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * 首页「最近打开」的入选条件：只收能点开的附件行。
 * 没有主附件（纯文献条目）、或主附件文件已丢失的，都不进列表。
 */
export function openedLiteratureAttachment(
  item: LiteratureSummary
): LiteratureAttachmentSummary | null {
  const attachment = item.primary_attachment
  // 附件行可以比它的字节活得久：文件被移走后只剩一条打不开的记录。
  return isAttachmentAvailable(attachment) ? attachment : null
}

/** 行图标种类；资产映射留在 HomeOverview（png 导入不进 node 测试面）。 */
export function openedLiteratureIconKind(item: LiteratureSummary): RecentLiteratureIconKind {
  const attachment = openedLiteratureAttachment(item)
  // 文件已丢失的主附件不算「有全文」: 首页那枚 PDF 图标承诺的是点开就能读。
  if (!attachment) return 'unknown'
  if (attachment.kind === 'pdf' || attachment.media_type === 'application/pdf') return 'pdf'
  const dot = attachment.name.lastIndexOf('.')
  const extension = dot >= 0 ? attachment.name.slice(dot + 1).toLowerCase() : ''
  const byExtension = ICON_KIND_BY_EXTENSION[extension]
  if (byExtension) return byExtension
  if (attachment.media_type.startsWith('text/') || TEXT_ATTACHMENT_EXTENSIONS.has(extension))
    return 'txt'
  if (attachment.media_type.startsWith('image/')) return 'img'
  if (attachment.media_type.startsWith('video/')) return 'video'
  if (attachment.media_type.startsWith('audio/')) return 'music'
  return 'unknown'
}
