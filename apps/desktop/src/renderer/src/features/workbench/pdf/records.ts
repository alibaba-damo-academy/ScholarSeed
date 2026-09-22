import type { PdfRecordSnapshot, PdfRecords } from '../../../contracts/workbench'

export const PDF_RECORD_SCHEMA_VERSION = 1
export const PDF_HIGHLIGHT_OPACITY = 0.32
export const PDF_SEARCH_HIGHLIGHT_OPACITY = 0.4
export const PDF_UNDERLINE_OPACITY = 0.9
export const PDF_UNDERLINE_THICKNESS = 1.5
export const PDF_STRIKETHROUGH_THICKNESS = 1.5

export const PDF_MARK_PALETTE = [
  { name: 'yellow', hex: '#f7d154', rgb: [0.96, 0.76, 0.18] },
  { name: 'orange', hex: '#f2a45c', rgb: [0.92, 0.53, 0.2] },
  { name: 'green', hex: '#77c98d', rgb: [0.35, 0.78, 0.47] },
  { name: 'teal', hex: '#70c7be', rgb: [0.27, 0.7, 0.66] },
  { name: 'blue', hex: '#72aee6', rgb: [0.32, 0.6, 0.9] },
  { name: 'purple', hex: '#b79bdb', rgb: [0.58, 0.42, 0.78] },
  { name: 'red', hex: '#e99188', rgb: [0.86, 0.34, 0.3] },
  { name: 'gray', hex: '#b9b5aa', rgb: [0.58, 0.56, 0.52] }
] as const

export type PdfMarkColor = typeof PDF_MARK_PALETTE[number]['name']

export const DEFAULT_PDF_MARK_COLOR: PdfMarkColor = 'yellow'
export const PDF_HIGHLIGHT_VISUAL_CLASS = 'absolute bg-[var(--pdf-mark-color)] opacity-[var(--pdf-mark-opacity)]'

export function stagePdfRecords(
  snapshot: PdfRecordSnapshot,
  records: PdfRecords
): PdfRecordSnapshot {
  return { ...snapshot, records }
}

export type PdfMarkCategory = 'all' | 'highlight' | 'underline' | 'strikethrough' | 'comment'

interface CategorizedMark {
  id: string
  style: 'highlight' | 'underline' | 'strikethrough'
}

export function pdfMarkVisualClass(style: CategorizedMark['style']): string {
  if (style === 'underline') {
    return 'border-b-[length:var(--pdf-mark-thickness)] border-b-[var(--pdf-mark-color)] opacity-[var(--pdf-mark-opacity)]'
  }
  return ''
}

interface MarkComment {
  mark_id: string
}

export function markCategory(mark: CategorizedMark, comments: readonly MarkComment[]): Exclude<PdfMarkCategory, 'all'> {
  if (comments.some((comment) => comment.mark_id === mark.id)) return 'comment'
  return mark.style
}

export function filterMarks<T extends CategorizedMark>(
  marks: readonly T[],
  comments: readonly MarkComment[],
  category: PdfMarkCategory
): T[] {
  return category === 'all' ? [...marks] : marks.filter((mark) => markCategory(mark, comments) === category)
}
export const PDF_MARK_COLORS = Object.fromEntries(
  PDF_MARK_PALETTE.map((color) => [color.name, color.hex])
) as Record<PdfMarkColor, string>
export const PDF_MARK_RGB = Object.fromEntries(
  PDF_MARK_PALETTE.map((color) => [color.name, color.rgb])
) as Record<PdfMarkColor, readonly [number, number, number]>
