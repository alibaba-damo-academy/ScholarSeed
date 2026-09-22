import type { RecordTarget } from './workbench'

/** Answer citation resolution and temporary PDF navigation, never user annotations. */
export const CITATION_VIEW_STATE_KEY = 'citationFocus'
export const isCitationUrl = (url: string): boolean => /^scholarseed-cite:/.test(url)
export interface CitationPage { page: number; quads: number[][] }
export interface CitationMatch { pages: CitationPage[] }
export interface CitationPresentation {
  version: number
  mode: 'structured_text' | 'region_image' | 'unavailable'
  precision: 'region' | 'page' | 'source'
  page?: number
  text: string
  quality_reasons: string[]
  manual_check: boolean
}
export interface CitationResolution {
  can_open_pdf?: boolean
  pipeline?: string
  fallback_reason?: string
  card_field?: string
  handle: string
  source_session_id?: string
  answer_session_id?: string
  answer_id?: string
  answer_revision?: string
  pages: CitationPage[]
  source_kind: string
  source_id: string
  content_level: string
  project_id: string
  scope_project_id?: string
  /** Annotation owner of the cited bytes; absent when the source has no PDF records. */
  record_target?: RecordTarget | null
  path: string
  title: string
  revision: string
  quote: string
  version_bound: boolean
  state: 'exact' | 'source_only' | 'unavailable' | 'changed'
  matches: CitationMatch[]
  presentation: CitationPresentation
}
export interface CitationFocus extends CitationMatch { revision: string; sequence: number }
export interface CitationLinkRange { start: number; end: number }
