import type { CellValue } from 'exceljs'

export const MAX_INLINE_SELECTION_CELLS = 150
export const DEFAULT_ROW_HEIGHT = 24
export const DEFAULT_COLUMN_WIDTH = 120
export const ROW_HEADER_WIDTH = 40
export const GRID_OVERSCAN = 5

/** Dates and floats have different JS/openpyxl serializations; resolve their evidence server-side. */
export function needsSourceReference(value: CellValue | undefined): boolean {
  if (value instanceof Date) return true
  if (typeof value === 'number') return !Number.isSafeInteger(value)
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) return needsSourceReference(value.result)
  return false
}

export function columnName(value: number): string {
  let result = ''
  for (let column = value; column > 0; column = Math.floor((column - 1) / 26)) {
    result = String.fromCharCode(65 + (column - 1) % 26) + result
  }
  return result
}

/** Evidence formatting matches the authoritative openpyxl data_only reader. */
export function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value instanceof Date) return value.toISOString().replace(/\.000Z$/, '').replace(/Z$/, '')
  if (typeof value !== 'object') return String(value)
  if ('formula' in value || 'sharedFormula' in value) return cellText(value.result)
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('error' in value) return value.error
  if ('text' in value) return value.text
  return ''
}

export function rangeText(rows: string[][]): string {
  const trimmed = rows.slice()
  while (trimmed.length && trimmed.at(-1)?.every((cell) => cell === '')) trimmed.pop()
  const width = trimmed.reduce((maximum, row) => Math.max(maximum, row.reduce((last, cell, index) => cell ? index + 1 : last, 0)), 0)
  return trimmed.map((row) => row.slice(0, width).join('\t')).join('\n')
}
