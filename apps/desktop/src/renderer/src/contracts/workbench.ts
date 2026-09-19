/**
 * workbench 域前端契约（开发 4 拥有）。
 *
 * 与 `service/workbench/domain/model.py` 对应。
 *
 * 关键点：`DocumentCapabilities` 由后端 `/api/workbench/open` 回报，前端
 * **不再按扩展名自行判断**（架构文档 §4.3）。这样"能不能编辑"只有一处答案。
 */

/** Viewer 种类。与后端 `ViewerKind` 同名。 */
export { resourceEditorHasChanges, reconcileResourceEditors } from '../features/workbench/workspace.ts'

export interface ResourceHistoryTarget {
  project: string
  fileId: string
  path: string
}

export type ViewerKind = 'markdown' | 'pdf' | 'table' | 'code' | 'image' | 'office' | 'spreadsheet' | 'unsupported'

export const DOCUMENT_PROCESSOR_KINDS = ['csv', 'xls', 'xlsx'] as const
export type DocumentProcessorKind = typeof DOCUMENT_PROCESSOR_KINDS[number]

export function isDocumentProcessorKind(value: unknown): value is DocumentProcessorKind {
  return typeof value === 'string' && DOCUMENT_PROCESSOR_KINDS.some((kind) => kind === value)
}

export type ContentKind = 'text' | 'binary' | 'oversized'

/**
 * 一份文档在当前实现下真正支持什么。
 *
 * `pending` 显式列出"PRD 要求但本期未实现"的能力，让 UI 能呈现「待实现」
 * 而不是静默缺失 —— 静默缺失会让用户以为是自己操作不对。
 */
export interface DocumentCapabilities {
  can_preview: boolean
  can_edit: boolean
  can_select: boolean
  can_annotate: boolean
  can_save: boolean
  can_version: boolean
  can_diff: boolean
  pending: string[]
}

/** `/api/workbench/open` 的响应。 */
export interface OpenDocumentResult {
  path: string
  viewer: ViewerKind
  processor: DocumentProcessorKind | null
  content_kind: ContentKind
  capabilities: DocumentCapabilities
  project_id: string
  media_type: string
  size: number
  revision: string
  content_url: string
  asset_id: string | null
  source_state: 'available' | 'missing' | 'authorization_required' | 'conflict' | null
}

/**
 * 打开一份文档的请求（架构文档 §3.4）。
 *
 * 资料库与文献库只发这个请求，不直接控制 Viewer —— 因此两个库都不需要知道
 * PDF 用什么渲染、Markdown 用哪个编辑器。
 */
export interface OpenDocumentRequest {
  path: string
  title: string
  page?: number
}

export type RecordOwner = 'project_asset' | 'literature_attachment'

export interface RecordTarget {
  owner: RecordOwner
  scope_id: string
  subject_id: string
}

export interface LiteratureDocumentSource {
  kind: 'literature'
  literatureId: string
  attachmentId: string
  recordTarget: RecordTarget
  path: string
  revision?: string
  mediaType?: string
  renderKind?: string
}

export interface PdfMarkRecord {
  id: string
  style: 'highlight' | 'underline' | 'strikethrough'
  color: 'yellow' | 'orange' | 'green' | 'teal' | 'blue' | 'purple' | 'red' | 'gray'
  page: number
  quads: number[][]
  text: string
  anchor_state: 'anchored' | 'stale'
  created_at: number
  updated_at: number
}

export interface PdfCommentRecord {
  id: string
  mark_id: string
  body: string
  created_at: number
}

export interface PdfNoteExcerptRecord {
  id: string
  mark_id: string
  text: string
  page: number
}

export interface PdfNoteRecord {
  id: string
  title: string
  body: string
  excerpts: PdfNoteExcerptRecord[]
}

export interface PdfRecords {
  schema_version: 1
  marks: PdfMarkRecord[]
  comments: PdfCommentRecord[]
  notes: PdfNoteRecord[]
}

export interface PdfRecordSnapshot {
  record_target: RecordTarget
  record_revision: string
  source_revision: string
  source_state: 'available' | 'missing' | 'authorization_required' | 'conflict'
  source_path: string
  records: PdfRecords
}

export const FIND_TEXT_REVEAL_KIND = 'find' as const

/** A search hit asks the active viewer to find this literal in its current bytes. */
export interface FindTextReveal {
  kind: typeof FIND_TEXT_REVEAL_KIND
  query: string
  source_revision: string
}

/**
 * 选区锚点。由 Viewer 产生，供 AI 面板引用。
 *
 * 页码与字符区间共用一个形状：PDF 给 page，文本给 start/end。
 * 两者不各自发明，否则 assistant 侧要按文件类型分支。
 */
export type SelectionLocator =
  | { kind: 'text'; start_line: number; start_column: number; end_line: number; end_column: number }
  | {
      kind: 'markdown'
      start: number
      end: number
      segments?: Array<{ start: number; end: number }>
      source_map_version: string
    }
  | { kind: 'pdf'; page: number; quads: number[][]; text_length?: number; text_shape_hash?: string }
  | {
      kind: 'writer'
      format: 'doc' | 'docx'
      paragraph: string
      end_paragraph?: string
      start: number
      end: number
    }
  | { kind: 'calc'; sheet: string; range: string; content_mode?: 'reference' }
  | { kind: 'impress'; slide: number; shape: string; start?: number; end?: number }

export interface SelectionAnchor {
  document_id: string
  document_session_id: string
  revision: string
  status: 'exact' | 'stale' | 'unavailable'
  text: string
  /** Current editor snapshot, never another file or chat context. */
  context_text?: string
  locator: SelectionLocator
}
