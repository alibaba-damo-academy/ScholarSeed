import { unzipSync } from 'fflate'

import { CONDITIONAL_ICONS, type ConditionalIconAsset } from './icons.ts'
import { resolveWorkbookColor, type WorkbookColor, type WorkbookStyles } from './styles.ts'
import { OOXML_NS, readXml, resolvePart } from './xml.ts'

const DOCUMENT_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DEFAULT_ICON_SET = '3TrafficLights1'
const DEFAULT_BAR_MINIMUM = 10
const DEFAULT_BAR_MAXIMUM = 90
const PERCENT = 100
const MAX_WORKSHEET_ROW = 1048576
const MAX_WORKSHEET_COLUMN = 16384
const CONSTANT_RANGE_FRACTION = .5
const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/
const THRESHOLD_TYPES = new Set(['min', 'max', 'num', 'percent', 'percentile'])
const COMPARISONS = new Set(['equal', 'notEqual', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'between', 'notBetween'])
export interface ConditionalRange { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number }
export interface ConditionalThreshold { readonly type: string; readonly value?: number; readonly gte: boolean }
interface RuleBase {
  readonly type: string
  readonly priority: number
  readonly ranges: readonly ConditionalRange[]
  readonly stopIfTrue: boolean
}
export interface ColorScaleRule extends RuleBase { readonly type: 'colorScale'; readonly thresholds: readonly ConditionalThreshold[]; readonly colors: readonly string[] }
export interface DataBarRule extends RuleBase { readonly type: 'dataBar'; readonly thresholds: readonly ConditionalThreshold[]; readonly color: string; readonly showValue: boolean; readonly minLength: number; readonly maxLength: number }
export interface IconSetRule extends RuleBase { readonly type: 'iconSet'; readonly thresholds: readonly ConditionalThreshold[]; readonly iconSet: string; readonly showValue: boolean; readonly reverse: boolean }
export interface NumericRule extends RuleBase { readonly type: 'cellIs'; readonly operator: string; readonly values: readonly number[] }
export interface UnsupportedRule extends RuleBase { readonly type: 'unsupported'; readonly originalType: string; readonly reason: string }
export type ConditionalRule = ColorScaleRule | DataBarRule | IconSetRule | NumericRule | UnsupportedRule
export interface ConditionalCell { readonly row: number; readonly column: number; readonly value: unknown }
export interface CompiledConditionalRule { readonly rule: ConditionalRule; readonly thresholds: readonly number[] }
export interface ConditionalDecoration {
  readonly background?: string
  readonly bar?: { readonly color: string; readonly fraction: number; readonly showValue: boolean }
  readonly icon?: { readonly asset: ConditionalIconAsset; readonly index: number; readonly set: string; readonly showValue: boolean }
  readonly showValue: boolean
}
function children(element: Element, name: string): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).namespaceURI === OOXML_NS.spreadsheet && (node as Element).localName === name)
}
function boolean(element: Element, name: string, fallback: boolean): boolean {
  const value = element.getAttribute(name)
  return value === null || value === '' ? fallback : value === '1' || value === 'true'
}
function literal(value: string | null): number | undefined {
  const text = value?.trim() ?? ''
  const number = NUMERIC_LITERAL.test(text) ? Number(text) : NaN
  return Number.isFinite(number) ? number : undefined
}
function point(value: string): { row: number; column: number } | undefined {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(value)
  if (!match) return undefined
  const column = Array.from(match[1]).reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0)
  const row = Number(match[2])
  return row > 0 && row <= MAX_WORKSHEET_ROW && column <= MAX_WORKSHEET_COLUMN ? { row, column } : undefined
}
function ranges(value: string): ConditionalRange[] {
  return value.trim().split(/\s+/).flatMap((reference) => {
    const pieces = reference.split(':')
    if (pieces.length > 2) return []
    const start = point(pieces[0]); const end = point(pieces[1] ?? pieces[0])
    return start && end ? [{ top: Math.min(start.row, end.row), left: Math.min(start.column, end.column), bottom: Math.max(start.row, end.row), right: Math.max(start.column, end.column) }] : []
  })
}
function color(node: Element, styles: WorkbookStyles): string | undefined {
  const value: WorkbookColor = {}
  if (node.hasAttribute('rgb')) value.argb = node.getAttribute('rgb')!
  if (node.hasAttribute('theme')) value.theme = literal(node.getAttribute('theme'))
  if (node.hasAttribute('indexed')) value.indexed = literal(node.getAttribute('indexed'))
  if (node.hasAttribute('tint')) value.tint = literal(node.getAttribute('tint'))
  if (node.hasAttribute('auto')) value.auto = boolean(node, 'auto', false)
  return resolveWorkbookColor(value, styles)
}
function thresholds(element: Element): ConditionalThreshold[] {
  return children(element, 'cfvo').map((node) => ({ type: node.getAttribute('type') ?? '', value: literal(node.getAttribute('val')), gte: boolean(node, 'gte', true) }))
}
function validThresholds(items: readonly ConditionalThreshold[]): boolean {
  return items.every((item) => THRESHOLD_TYPES.has(item.type) && (item.type === 'min' || item.type === 'max' || item.value !== undefined) && (!['percent', 'percentile'].includes(item.type) || (item.value! >= 0 && item.value! <= PERCENT)))
}
function parseRule(node: Element, locations: readonly ConditionalRange[], styles: WorkbookStyles): ConditionalRule {
  const type = node.getAttribute('type') ?? ''
  const base = { ranges: locations, priority: literal(node.getAttribute('priority')) ?? Number.MAX_SAFE_INTEGER, stopIfTrue: boolean(node, 'stopIfTrue', false) }
  const unsupported = (reason: string): UnsupportedRule => ({ ...base, type: 'unsupported', originalType: type, reason })
  if (!locations.length) return unsupported('unsupported-reference')
  const payload = children(node, type)[0]
  if (['colorScale', 'dataBar', 'iconSet'].includes(type)) {
    if (!payload) return unsupported('missing-payload')
    const points = thresholds(payload)
    if (!validThresholds(points)) return unsupported('unsupported-threshold')
    if (type === 'colorScale') {
      const colors = children(payload, 'color').map((item) => color(item, styles))
      return [2, 3].includes(points.length) && colors.length === points.length && colors.every((item) => item !== undefined)
        ? { ...base, type, thresholds: points, colors: colors as string[] } : unsupported('invalid-color-scale')
    }
    if (type === 'dataBar') {
      const selected = children(payload, 'color')[0]
      const paint = selected && color(selected, styles)
      const minLength = literal(payload.getAttribute('minLength')) ?? DEFAULT_BAR_MINIMUM
      const maxLength = literal(payload.getAttribute('maxLength')) ?? DEFAULT_BAR_MAXIMUM
      return points.length === 2 && paint && minLength >= 0 && minLength <= maxLength && maxLength <= PERCENT
        ? { ...base, type, thresholds: points, color: paint, showValue: boolean(payload, 'showValue', true), minLength, maxLength } : unsupported('invalid-data-bar')
    }
    const iconSet = payload.getAttribute('iconSet') || DEFAULT_ICON_SET
    const assets = CONDITIONAL_ICONS[iconSet]
    return assets && points.length === assets.length
      ? { ...base, type: 'iconSet', thresholds: points, iconSet, showValue: boolean(payload, 'showValue', true), reverse: boolean(payload, 'reverse', false) } : unsupported('unsupported-icon-set')
  }
  if (type === 'cellIs') {
    const operator = node.getAttribute('operator') ?? ''
    const values = children(node, 'formula').map((item) => literal(item.textContent))
    const count = ['between', 'notBetween'].includes(operator) ? 2 : 1
    if (COMPARISONS.has(operator) && values.length === count && values.every((value) => value !== undefined)) return { ...base, type, operator, values: values as number[] }
    return unsupported('unsupported-comparison')
  }
  return unsupported('unsupported-rule')
}
function relationshipPath(owner: string): string {
  const slash = owner.lastIndexOf('/')
  return owner ? `${owner.slice(0, slash + 1)}_rels/${owner.slice(slash + 1)}.rels` : '_rels/.rels'
}
function links(entries: Record<string, Uint8Array>, owner: string): Map<string, { target: string; type: string }> {
  const bytes = entries[relationshipPath(owner)]
  return new Map(bytes ? Array.from(readXml(bytes).getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')).filter((node) => node.getAttribute('TargetMode') !== 'External').map((node) => [node.getAttribute('Id') ?? '', { target: node.getAttribute('Target') ?? '', type: node.getAttribute('Type') ?? '' }]) : [])
}
/** Read source XML once; do not rely on ExcelJS's lossy conditional-format parser. */
export function readConditionalFormats(bytes: Uint8Array, styles: WorkbookStyles): ReadonlyMap<string, readonly ConditionalRule[]> {
  const entries = unzipSync(bytes)
  const office = Array.from(links(entries, '').values()).find((item) => item.type.endsWith('/officeDocument'))
  if (!office) return new Map()
  const workbook = resolvePart('', office.target)
  if (!entries[workbook]) return new Map()
  const relations = links(entries, workbook)
  const sheets = readXml(entries[workbook]).getElementsByTagNameNS(OOXML_NS.spreadsheet, 'sheet')
  return new Map(Array.from(sheets).map((sheet) => {
    const relation = relations.get(sheet.getAttributeNS(DOCUMENT_RELATIONSHIPS, 'id') ?? '')
    const owner = relation && relation.type.endsWith('/worksheet') ? resolvePart(workbook, relation.target) : undefined
    const source = owner && entries[owner]
    const rules = source ? children(readXml(source).documentElement, 'conditionalFormatting').flatMap((item) => children(item, 'cfRule').map((node) => parseRule(node, ranges(item.getAttribute('sqref') ?? ''), styles))) : []
    return [sheet.getAttribute('name') ?? '', rules]
  }))
}
export function conditionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value && typeof value === 'object' && 'result' in value) return conditionalNumber(value.result)
  return undefined
}
function contains(locations: readonly ConditionalRange[], row: number, column: number): boolean {
  return locations.some((range) => row >= range.top && row <= range.bottom && column >= range.left && column <= range.right)
}
export function percentile(values: readonly number[], percent: number): number | undefined {
  if (!values.length) return undefined
  const position = (values.length - 1) * Math.max(0, Math.min(PERCENT, percent)) / PERCENT
  const lower = Math.floor(position); const upper = Math.ceil(position)
  return values[lower] + (values[upper] - values[lower]) * (position - lower)
}
/** Iterate existing populated cells; never instantiate cells for an entire sqref rectangle. */
export function compileConditionalFormats(rules: readonly ConditionalRule[], cells: Iterable<ConditionalCell>): readonly CompiledConditionalRule[] {
  const numeric: { row: number; column: number; value: number }[] = []
  for (const cell of cells) {
    const value = conditionalNumber(cell.value)
    if (value !== undefined) numeric.push({ row: cell.row, column: cell.column, value })
  }
  return [...rules].sort((left, right) => left.priority - right.priority).map((rule) => {
    if (!('thresholds' in rule)) return { rule, thresholds: [] }
    const values = numeric.filter((cell) => contains(rule.ranges, cell.row, cell.column)).map((cell) => cell.value).sort((a, b) => a - b)
    const minimum = values[0]; const maximum = values.at(-1)
    const resolved = rule.thresholds.map((item) => {
      if (item.type === 'num') return item.value
      if (item.type === 'min') return minimum
      if (item.type === 'max') return maximum
      if (item.type === 'percent') return minimum === undefined || maximum === undefined ? undefined : minimum + (maximum - minimum) * item.value! / PERCENT
      return percentile(values, item.value!)
    })
    return { rule, thresholds: resolved.every((value) => value !== undefined) ? resolved as number[] : [] }
  })
}
function comparison(rule: NumericRule, value: number): boolean {
  const [first, second] = rule.values
  switch (rule.operator) {
    case 'equal': return value === first
    case 'notEqual': return value !== first
    case 'lessThan': return value < first
    case 'lessThanOrEqual': return value <= first
    case 'greaterThan': return value > first
    case 'greaterThanOrEqual': return value >= first
    case 'between': return value >= first && value <= second
    case 'notBetween': return value < first || value > second
    default: return false
  }
}
function fraction(value: number, lower: number, upper: number): number {
  // A constant range has no relative ordering: use the middle of the scale.
  return lower === upper ? CONSTANT_RANGE_FRACTION : Math.max(0, Math.min(1, (value - lower) / (upper - lower)))
}
function mix(left: string, right: string, ratio: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const lower = parseInt(left.slice(offset, offset + 2), 16)
    const upper = parseInt(right.slice(offset, offset + 2), 16)
    return Math.round(lower + (upper - lower) * ratio).toString(16).padStart(2, '0')
  })
  return `#${channels.join('').toUpperCase()}`
}
/** Decorations never modify cell.value, its cached formula result, or source bytes. */
export function conditionalDecoration(compiled: readonly CompiledConditionalRule[], row: number, column: number, sourceValue: unknown): ConditionalDecoration {
  let background: string | undefined
  let bar: ConditionalDecoration['bar']
  let icon: ConditionalDecoration['icon']
  const value = conditionalNumber(sourceValue)
  if (value === undefined) return { showValue: true }
  for (const { rule, thresholds: points } of compiled) {
    if (!contains(rule.ranges, row, column)) continue
    if (rule.type === 'cellIs') {
      if (rule.stopIfTrue && comparison(rule, value)) break
      continue
    }
    // The first icon cfvo is not a comparison boundary. It may be a percent0
    // domain minimum above a following authored numeric boundary (Regional sales).
    const firstOrdered = rule.type === 'iconSet' ? 2 : 1
    if (rule.type === 'unsupported' || !points.length || points.some((point, index) => index >= firstOrdered && point < points[index - 1])) continue
    if (rule.type === 'colorScale' && background === undefined) {
      const segment = points.length === 3 && value > points[1] ? 1 : 0
      background = mix(rule.colors[segment], rule.colors[segment + 1], fraction(value, points[segment], points[segment + 1]))
    } else if (rule.type === 'dataBar' && !bar) {
      bar = { color: rule.color, fraction: (rule.minLength + fraction(value, points[0], points[1]) * (rule.maxLength - rule.minLength)) / PERCENT, showValue: rule.showValue }
    } else if (rule.type === 'iconSet' && !icon) {
      let index = 0
      for (let cursor = 1; cursor < points.length; cursor++) {
        if (rule.thresholds[cursor].gte ? value >= points[cursor] : value > points[cursor]) index = cursor
      }
      if (rule.reverse) index = points.length - 1 - index
      icon = { asset: CONDITIONAL_ICONS[rule.iconSet][index], index, set: rule.iconSet, showValue: rule.showValue }
    }
  }
  return { background, bar, icon, showValue: bar?.showValue !== false && icon?.showValue !== false }
}
