/** Public renderer contract for the global literature catalogue. */
import type { RecordTarget } from './workbench'

/** `attachment` 不是文献字段，而是「有没有附件」的派生排序键（有=0，无=1）。 */
export type LiteratureSort = 'attachment' | 'citation_key' | 'item_type' | 'bib_type' | 'title' | 'subtitle' | 'creator' | 'publication' | 'year' | 'published_date' | 'doi' | 'arxiv' | 'isbn' | 'url' | 'volume' | 'number' | 'pages' | 'publisher' | 'address' | 'created_at' | 'updated_at' | 'last_read_at'
export type SortOrder = 'asc' | 'desc'
export type AttachmentFilter = 'any' | 'with_pdf' | 'without_pdf'
export interface LiteratureFacet { id: string; name: string; count: number; color?: string | null; parent_id?: string | null; project_id?: string | null }
/**
 * 标签 facet 带两个计数口径：count 按当前项目范围（文献全览时即全库），total 始终是全库。
 * 删除标签是全库操作，确认框必须用 total，否则在项目内会少报影响面。
 */
export interface LiteratureTagFacet extends LiteratureFacet { total: number }
export type AttachmentAvailability = 'available' | 'missing'
export interface LiteratureAttachmentSummary {
  id: string; name: string; kind: string; availability: AttachmentAvailability; created_at?: string
  role: 'primary' | 'supplementary'; media_type: string; size: number | null; annotation_count: number
  record_target: RecordTarget
}

/**
 * 附件行可以比它的字节活得久(清理被打断、库被回滚、文件被外部移走),
 * 所以「有没有主附件」必须看 availability, 不能只看行在不在。
 */
export const ATTACHMENT_MISSING: AttachmentAvailability = 'missing'
export const isAttachmentAvailable = (
  attachment: { availability: string } | null | undefined
): boolean => attachment != null && attachment.availability !== ATTACHMENT_MISSING
export interface LiteratureSummary {
  id: string; item_type: string; bib_type: string; title: string; creators_display: string
  citation_key?: string | null; subtitle?: string | null; abstract?: string | null
  doi?: string | null; arxiv?: string | null; isbn?: string | null; url?: string | null
  volume?: string | null; number?: string | null; pages?: string | null
  publisher?: string | null; address?: string | null
  publication_display: string; year: number | null; published_date: string | null
  created_at: string; updated_at: string; last_read_at: string | null; read_progress: number
  is_unread: boolean; primary_attachment: LiteratureAttachmentSummary | null
  attachments: LiteratureAttachmentSummary[]
  collections: LiteratureFacet[]; project_collections: LiteratureFacet[]; tags: LiteratureFacet[]
  projects: LiteratureFacet[]; version: number
}
export interface LiteratureNote {
  id: string
  title: string
  text: string
  created_at: number
  updated_at: number
  version: number
  position: number
}
export interface LiteratureDetail extends LiteratureSummary {
  citation_key?: string | null; subtitle?: string | null; abstract?: string | null; doi?: string | null; arxiv?: string | null; isbn?: string | null
  issn?: string | null; url?: string | null; volume?: string | null; number?: string | null
  pages?: string | null; publisher?: string | null; address?: string | null; attachment_count?: number
  note_count?: number
  notes?: LiteratureNote[]
}
export interface LiteratureUpdate {
  fields?: Record<string, string | number | null>
  bib_type?: string
  collection_ids?: string[]
  tag_ids?: string[]
  project_ids?: string[]
  project_collection_ids?: string[]
}
export interface LiteratureQuery {
  q?: string; collection_id?: string[]; without_collection?: boolean; recent?: boolean; tag_id?: string[]
  project_id?: string; without_project?: boolean; item_type?: string[]; bib_type?: string[]
  year_from?: number; year_to?: number; attachment?: AttachmentFilter; is_unread?: boolean
  sort?: LiteratureSort; order?: SortOrder; page?: number; page_size?: number
}
export interface LiteraturePage { items: LiteratureSummary[]; page: number; page_size: number; total: number; next_cursor: string | null }
export interface LiteratureCounts { all: number; recent: number; without_collection: number; unread: number; without_fulltext: number }
export interface LiteratureFacets {
  collections: LiteratureFacet[]; tags: LiteratureTagFacet[]; item_types: LiteratureFacet[]
  publications: LiteratureFacet[]; years: Array<{ value: number; count: number }>
}
export interface LiteratureProject {
  id: string; name: string; count: number; collections: LiteratureFacet[]
}
export interface LiteratureProjects {
  projects: LiteratureProject[]; current: string
}
export interface LiteratureTask {
  id: string; kind: string; status: string; progress: number; completed_count: number
  total_count: number; error?: string | null; error_code?: string | null; imported_ids?: string[]
}
export type LiteratureSearchStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'empty'
export interface LiteratureSearchPaper {
  url?: string | null
  paper_id: string; title: string; authors: string[]; year: number | null; venue: string
  abstract: string; citation_count: number | null; doi: string; arxiv_id: string
  tier: number | null; reason: string; subtopics_covered: string[]; access: string; source: string
  decision?: 'included' | 'excluded' | 'candidate'; decision_reason?: string | null
  fulltext?: 'fulltext' | 'abstract' | 'unknown'
}
export interface LiteratureSearchResult {
  search_summary?: {
    query?: string; total_rounds?: number; total_queries?: number; pool_size?: number
    selected_count?: number; subtopics?: string[]; coverage_assessment?: string
  }
  papers: LiteratureSearchPaper[]
}
export interface LiteratureSearchTask {
  id: string
  query: string
  created_at: number
  completed_at?: number | null
  status: LiteratureSearchStatus
  last_seq: number
  output: string
  error?: string | null
  result?: LiteratureSearchResult | null
}
export interface LiteratureSearchEvent {
  schema_version: number
  task_id?: string
  invocation_id?: string
  seq: number
  type: string
  created_at?: number
  data: Record<string, unknown>
}
export interface ApiFailure { status: number; code: string; message: string; fields?: Record<string, string>; request_id?: string }
export interface LiteratureRef { id: string; title: string; pdfPath?: string | null }

export interface ConversationSearchPaper {
  id: string; title: string; authors: string[]; year: number | null; venue: string | null
  doi: string | null; url: string | null; abstract: string | null; reasons: string[]; access: string; sources: string[]
  tier?: number | null; citation_count?: number | null
  decision?: 'included' | 'excluded' | 'candidate'; decision_reason?: string | null
  fulltext?: 'fulltext' | 'abstract' | 'unknown'
}
export interface ConversationSearchResult {
  schema_version: string; session_id: string; run_id: string; round: number; status: string
  criteria: string[]; sources: { name: string; status: string; queries: number | null; candidates: number | null }[]
  candidates: number | null; deduplicated: number | null; retained: number; papers: ConversationSearchPaper[]; warnings: string[]
  metadata: { artifact_id: string }
  report: { artifact_id: string; path: string; name: string; media_type: string; size: number }
  origin?: 'precise-search' | 'literature-review' | 'slr-codex' | 'agentic-search'
  selection?: { artifact_id?: string }
  fulltext?: { artifact_id?: string }
}
export interface ReviewArtifact {
  artifact_id: string; path: string; name: string; title: string
  media_type?: string; size?: number; sha256: string
}
export interface ReviewSection {
  id: string; title: string; description: string; papers: number; children: string[]; comparison_tables: string[]
}
export interface ReviewCheck {
  title: string; verdict: 'PASS' | 'WARN' | 'FAIL' | 'NOT_CHECKED' | 'NOT_APPLICABLE'; reason: string
}
export interface LiteratureReview {
  schema_version: '1.1'; workspace: string; session_id: string
  checkpoint: 'outline' | 'result'; intent: string; title: string
  status: 'outline' | 'generated' | 'partial' | 'incomplete' | 'failed'
  generation_status?: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | null
  scope: { topic: string; time_range: string; focus: string[]; requested_materials: string[]; project_materials: number | null; external_materials: number | null }
  output: { format: 'latex_pdf' | 'markdown' | null; citation_style: 'numeric' | 'author_year' | 'ieee' | 'acm' | null; decided_by: 'user' | 'default' | null }
  included: number | null; fulltext: number | null; abstract_only: number | null; pending_checks: number | null; cited: number | null
  section_count: number; sections: ReviewSection[]; checks: ReviewCheck[]
  citations: Array<{ title: string; authors: string; year: number | null; venue: string }>
  abstract_evidence: Array<{ paper_id: string; title: string; reason: string }>
  issues: Array<{ title: string; detail: string; paper_ids: string[]; affected_content: string }>
  warnings: string[]; source_hashes: Record<string, string>; artifacts: ReviewArtifact[]
}
