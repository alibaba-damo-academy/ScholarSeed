/**
 * resources 域前端契约（开发 2 拥有）。
 *
 * 架构文档 §4.2 规定各功能域只能修改自己的契约文件，跨域需求通过契约解决，
 * 不允许直接 import 对方的内部组件或 Hook。
 *
 * 因此本文件是资料库对外的**唯一**类型入口：其他 Feature 从这里 import，
 * 而不是深入 `features/resources/` 内部。类型实现仍在 Feature 内，
 * 这里只做再导出 —— 避免同一形状定义两遍后逐渐漂移。
 */

export { snapshotSaveMessage } from '../features/resources/pending.ts'

export type {
  NodeAction,
  ResourceCapability,
  ResourcePending,
  ResourceSnapshot,
  ResourceReviewAction,
  ResourceReviewBatch,
  ResourceReviewBatchDecision,
  ResourceReviewBatchMember,
  ResourceReviewBatchMutation,
  ResourceReviewBatchPage,
  ResourceReviewBatchResult,
  ResourceReviewBatchState,
  ResourceReviewConflict,
  ResourceReviewResolution,
  ResourceDelivery,
  ResourceDeliveryEntry,
  ResourceDeliveryMember,
  ResourceDeliveryRestoreMember,
  ResourceDeliveryRestorePreview,
  ResourceDeliveryRestoreResult,
  ResourceMutation,
  ResourceRestorePreview,
  ResourceRestoreMutation,
  ResourceSearchHit,
  ResourceVersion,
  ResourceVersionDeletePreview,
  ResourceVersionQuery,
  ResourceVersionPage,
  ResourceVersionAnnotations
} from '../features/resources/api.ts'

export {
  fetchResourceDeliveries,
  fetchResourceVersionContent,
  fetchResourceVersionAnnotations,
  fetchResourceVersions,
  updateResourceVersionAlias,
  previewResourceVersionDelete,
  deleteResourceVersion,
  fetchVersionCapability,
  decideResourceReview,
  decideResourceReviewBatch,
  fetchResourceReviewBatch,
  fetchResourceReviewBatches,
  hasDirtyReviewEditor,
  fetchReviewMemberContent,
  fetchReviewMemberCurrent,
  fetchReviewBaseline,
  fetchResourceReviewConflict,
  reconcileResourceReview,
  reviewConflictMatches,
  previewDeliveryRestore,
  previewResourceRestore,
  restoreResourceDelivery,
  saveResourceVersionAs,
  sealResourceSnapshot,
  sealResourceVersion,
  sealExternalResourceVersion,
  restoreResourceVersion
} from '../features/resources/api.ts'

export type {
  FileVersionRetentionPreview,
  FileVersionScanSummary,
  FileVersionSettings
} from '../features/resources/settings.ts'

export {
  applyFileVersionSettings,
  fileVersionScanSummary,
  loadFileVersionSettings,
  previewFileVersionSettings
} from '../features/resources/settings.ts'

export type {
  ImportDialogState,
  ImportMode,
  MoveDialogState,
  NodeMenuState,
  ResourceNode,
  ResourceState
} from '../features/resources/state.ts'

/** 资料列表筛选维度。与 `service/resources/domain/model.py` 对应。 */
export type ResourceFilter = 'all' | 'agent_output' | 'documents'

/**
 * AI 产物目录名（PRD「基于 AI 回答新建文档」）。
 *
 * 与后端 `AGENT_OUTPUT_DIR` 必须一致：前端据此在资料树里高亮产物目录。
 */
export const AGENT_OUTPUT_DIR = 'ai_extracts'

/** 资料落地位置；parent 始终相对资料库根。 */
export interface ResourceLocationRef {
  parent: string
  name: string
}

export const LITERATURE_EXCERPT_SOURCE_KIND = 'literature' as const
export const PDF_EXCERPT_LOCATOR_KIND = 'pdf' as const
export const LITERATURE_EXCERPT_VIEW_STATE_KEY = 'literatureExcerpt' as const

export type PdfExcerptQuad = readonly [number, number, number, number]

export interface LiteratureExcerptSource {
  kind: typeof LITERATURE_EXCERPT_SOURCE_KIND
  literatureId: string
  title: string
}

export interface LiteratureExcerptSelection {
  text: string
  locator: {
    kind: typeof PDF_EXCERPT_LOCATOR_KIND
    page: number
    quads?: readonly PdfExcerptQuad[]
  }
}

/** 读取 PDF 标签可选携带的文献身份。 */
export function asLiteratureExcerptSource(value: unknown): LiteratureExcerptSource | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<LiteratureExcerptSource>
  if (
    candidate.kind !== LITERATURE_EXCERPT_SOURCE_KIND
    || typeof candidate.literatureId !== 'string'
    || !candidate.literatureId.trim()
    || typeof candidate.title !== 'string'
    || !candidate.title.trim()
  ) return null
  return {
    kind: LITERATURE_EXCERPT_SOURCE_KIND,
    literatureId: candidate.literatureId,
    title: candidate.title
  }
}

export { expandedResourceAncestors } from '../features/resources/lifecycle.ts'
