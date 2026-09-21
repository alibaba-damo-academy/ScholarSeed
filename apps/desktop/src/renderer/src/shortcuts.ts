import type {
  PreferenceShortcutBinding,
  PreferenceShortcutModifier,
  PreferenceShortcutOverrides
} from '../../preferences'
import { isPreferenceShortcutBindingAllowed } from '../../preferences.ts'

export type ShortcutScope = 'markdown' | 'code' | 'pdf'
export type ShortcutPlatform = 'mac' | 'windows'
export type ShortcutModifier = PreferenceShortcutModifier
export type ShortcutContext =
  | 'markdown.visual'
  | 'code.editable'
  | 'pdf.open'
export type ShortcutMessageKey =
  | 'markdownSave'
  | 'markdownUndo'
  | 'markdownRedo'
  | 'markdownFind'
  | 'markdownSelectAll'
  | 'markdownBold'
  | 'markdownItalic'
  | 'markdownStrikethrough'
  | 'markdownInlineCode'
  | 'markdownLink'
  | 'markdownParagraph'
  | 'markdownHeading1'
  | 'markdownHeading2'
  | 'markdownHeading3'
  | 'markdownHeading4'
  | 'markdownHeading5'
  | 'markdownHeading6'
  | 'codeSave'
  | 'codeSaveAll'
  | 'codeUndo'
  | 'codeRedo'
  | 'codeFind'
  | 'codeReplace'
  | 'codeGoToLine'
  | 'codeLineComment'
  | 'codeIndent'
  | 'codeOutdent'
  | 'pdfFind'
  | 'pdfFindNext'
  | 'pdfFindPrevious'
  | 'pdfPreviousPage'
  | 'pdfNextPage'
  | 'pdfFirstPage'
  | 'pdfLastPage'
  | 'pdfGoToPage'
  | 'pdfZoomIn'
  | 'pdfZoomOut'
  | 'pdfActualSize'
  | 'pdfScrollUp'
  | 'pdfScrollDown'
  | 'pdfScrollLeft'
  | 'pdfScrollRight'
  | 'pdfScrollPageDown'
  | 'pdfScrollPageUp'
  | 'pdfHighlight'
  | 'pdfComment'
  | 'pdfCopyText'

export type ShortcutCommandId =
  | 'markdown.save'
  | 'markdown.undo'
  | 'markdown.redo'
  | 'markdown.find'
  | 'markdown.selectAll'
  | 'markdown.bold'
  | 'markdown.italic'
  | 'markdown.strikethrough'
  | 'markdown.inlineCode'
  | 'markdown.link'
  | 'markdown.paragraph'
  | 'markdown.heading1'
  | 'markdown.heading2'
  | 'markdown.heading3'
  | 'markdown.heading4'
  | 'markdown.heading5'
  | 'markdown.heading6'
  | 'code.save'
  | 'code.saveAll'
  | 'code.undo'
  | 'code.redo'
  | 'code.find'
  | 'code.replace'
  | 'code.goToLine'
  | 'code.lineComment'
  | 'code.indent'
  | 'code.outdent'
  | 'pdf.find'
  | 'pdf.findNext'
  | 'pdf.findPrevious'
  | 'pdf.previousPage'
  | 'pdf.nextPage'
  | 'pdf.firstPage'
  | 'pdf.lastPage'
  | 'pdf.goToPage'
  | 'pdf.zoomIn'
  | 'pdf.zoomOut'
  | 'pdf.actualSize'
  | 'pdf.scrollUp'
  | 'pdf.scrollDown'
  | 'pdf.scrollLeft'
  | 'pdf.scrollRight'
  | 'pdf.scrollPageDown'
  | 'pdf.scrollPageUp'
  | 'pdf.highlight'
  | 'pdf.comment'
  | 'pdf.copyText'

export type ShortcutBinding = PreferenceShortcutBinding
export type ShortcutOverrides = PreferenceShortcutOverrides

export interface ShortcutDefinition {
  bindings: readonly ShortcutBinding[]
  id: ShortcutCommandId
  messageKey: ShortcutMessageKey
  scope: ShortcutScope
  when: ShortcutContext
}

export interface ShortcutEvent {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

const PRIMARY = ['primary'] as const
const PRIMARY_SHIFT = ['primary', 'shift'] as const
const PRIMARY_ALT = ['primary', 'alt'] as const
const SHIFT = ['shift'] as const
const UNMODIFIED = [] as const
const binding = (key: string, modifiers: readonly ShortcutModifier[] = PRIMARY): readonly ShortcutBinding[] => ([{ key, modifiers }])
const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])
const SHORTCUT_KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑'
}
const RESERVED_PRIMARY_KEYS: Readonly<Record<ShortcutPlatform, ReadonlySet<string>>> = {
  mac: new Set(['h', 'm', 'q', 'w']),
  windows: new Set(['r', 'w'])
}
let activeShortcutOverrides: ShortcutOverrides = {}

export const SHORTCUT_SCOPE_ORDER: readonly ShortcutScope[] = [
  'markdown',
  'code',
  'pdf'
]

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: 'markdown.save', messageKey: 'markdownSave', scope: 'markdown', when: 'markdown.visual', bindings: binding('s') },
  { id: 'markdown.undo', messageKey: 'markdownUndo', scope: 'markdown', when: 'markdown.visual', bindings: binding('z') },
  { id: 'markdown.redo', messageKey: 'markdownRedo', scope: 'markdown', when: 'markdown.visual', bindings: binding('z', PRIMARY_SHIFT) },
  { id: 'markdown.find', messageKey: 'markdownFind', scope: 'markdown', when: 'markdown.visual', bindings: binding('f') },
  { id: 'markdown.selectAll', messageKey: 'markdownSelectAll', scope: 'markdown', when: 'markdown.visual', bindings: binding('a') },
  { id: 'markdown.bold', messageKey: 'markdownBold', scope: 'markdown', when: 'markdown.visual', bindings: binding('b') },
  { id: 'markdown.italic', messageKey: 'markdownItalic', scope: 'markdown', when: 'markdown.visual', bindings: binding('i') },
  { id: 'markdown.strikethrough', messageKey: 'markdownStrikethrough', scope: 'markdown', when: 'markdown.visual', bindings: binding('x', PRIMARY_SHIFT) },
  { id: 'markdown.inlineCode', messageKey: 'markdownInlineCode', scope: 'markdown', when: 'markdown.visual', bindings: binding('`') },
  { id: 'markdown.link', messageKey: 'markdownLink', scope: 'markdown', when: 'markdown.visual', bindings: binding('k') },
  { id: 'markdown.paragraph', messageKey: 'markdownParagraph', scope: 'markdown', when: 'markdown.visual', bindings: binding('0') },
  { id: 'markdown.heading1', messageKey: 'markdownHeading1', scope: 'markdown', when: 'markdown.visual', bindings: binding('1') },
  { id: 'markdown.heading2', messageKey: 'markdownHeading2', scope: 'markdown', when: 'markdown.visual', bindings: binding('2') },
  { id: 'markdown.heading3', messageKey: 'markdownHeading3', scope: 'markdown', when: 'markdown.visual', bindings: binding('3') },
  { id: 'markdown.heading4', messageKey: 'markdownHeading4', scope: 'markdown', when: 'markdown.visual', bindings: binding('4') },
  { id: 'markdown.heading5', messageKey: 'markdownHeading5', scope: 'markdown', when: 'markdown.visual', bindings: binding('5') },
  { id: 'markdown.heading6', messageKey: 'markdownHeading6', scope: 'markdown', when: 'markdown.visual', bindings: binding('6') },
  { id: 'code.save', messageKey: 'codeSave', scope: 'code', when: 'code.editable', bindings: binding('s') },
  { id: 'code.saveAll', messageKey: 'codeSaveAll', scope: 'code', when: 'code.editable', bindings: binding('s', PRIMARY_ALT) },
  { id: 'code.undo', messageKey: 'codeUndo', scope: 'code', when: 'code.editable', bindings: binding('z') },
  { id: 'code.redo', messageKey: 'codeRedo', scope: 'code', when: 'code.editable', bindings: binding('z', PRIMARY_SHIFT) },
  { id: 'code.find', messageKey: 'codeFind', scope: 'code', when: 'code.editable', bindings: binding('f') },
  { id: 'code.replace', messageKey: 'codeReplace', scope: 'code', when: 'code.editable', bindings: binding('f', PRIMARY_ALT) },
  { id: 'code.goToLine', messageKey: 'codeGoToLine', scope: 'code', when: 'code.editable', bindings: binding('l') },
  { id: 'code.lineComment', messageKey: 'codeLineComment', scope: 'code', when: 'code.editable', bindings: binding('/') },
  { id: 'code.indent', messageKey: 'codeIndent', scope: 'code', when: 'code.editable', bindings: binding('Tab', UNMODIFIED) },
  { id: 'code.outdent', messageKey: 'codeOutdent', scope: 'code', when: 'code.editable', bindings: binding('Tab', SHIFT) },
  { id: 'pdf.find', messageKey: 'pdfFind', scope: 'pdf', when: 'pdf.open', bindings: binding('f') },
  { id: 'pdf.findNext', messageKey: 'pdfFindNext', scope: 'pdf', when: 'pdf.open', bindings: binding('Enter', UNMODIFIED) },
  { id: 'pdf.findPrevious', messageKey: 'pdfFindPrevious', scope: 'pdf', when: 'pdf.open', bindings: binding('Enter', SHIFT) },
  { id: 'pdf.previousPage', messageKey: 'pdfPreviousPage', scope: 'pdf', when: 'pdf.open', bindings: binding('PageUp', UNMODIFIED) },
  { id: 'pdf.nextPage', messageKey: 'pdfNextPage', scope: 'pdf', when: 'pdf.open', bindings: binding('PageDown', UNMODIFIED) },
  { id: 'pdf.firstPage', messageKey: 'pdfFirstPage', scope: 'pdf', when: 'pdf.open', bindings: binding('Home', UNMODIFIED) },
  { id: 'pdf.lastPage', messageKey: 'pdfLastPage', scope: 'pdf', when: 'pdf.open', bindings: binding('End', UNMODIFIED) },
  { id: 'pdf.goToPage', messageKey: 'pdfGoToPage', scope: 'pdf', when: 'pdf.open', bindings: binding('l') },
  { id: 'pdf.zoomIn', messageKey: 'pdfZoomIn', scope: 'pdf', when: 'pdf.open', bindings: binding('+', PRIMARY_SHIFT) },
  { id: 'pdf.zoomOut', messageKey: 'pdfZoomOut', scope: 'pdf', when: 'pdf.open', bindings: binding('-') },
  { id: 'pdf.actualSize', messageKey: 'pdfActualSize', scope: 'pdf', when: 'pdf.open', bindings: binding('0') },
  { id: 'pdf.scrollUp', messageKey: 'pdfScrollUp', scope: 'pdf', when: 'pdf.open', bindings: binding('ArrowUp', UNMODIFIED) },
  { id: 'pdf.scrollDown', messageKey: 'pdfScrollDown', scope: 'pdf', when: 'pdf.open', bindings: binding('ArrowDown', UNMODIFIED) },
  { id: 'pdf.scrollLeft', messageKey: 'pdfScrollLeft', scope: 'pdf', when: 'pdf.open', bindings: binding('ArrowLeft', UNMODIFIED) },
  { id: 'pdf.scrollRight', messageKey: 'pdfScrollRight', scope: 'pdf', when: 'pdf.open', bindings: binding('ArrowRight', UNMODIFIED) },
  { id: 'pdf.scrollPageDown', messageKey: 'pdfScrollPageDown', scope: 'pdf', when: 'pdf.open', bindings: binding('Space', UNMODIFIED) },
  { id: 'pdf.scrollPageUp', messageKey: 'pdfScrollPageUp', scope: 'pdf', when: 'pdf.open', bindings: binding('Space', SHIFT) },
  { id: 'pdf.highlight', messageKey: 'pdfHighlight', scope: 'pdf', when: 'pdf.open', bindings: [] },
  { id: 'pdf.comment', messageKey: 'pdfComment', scope: 'pdf', when: 'pdf.open', bindings: [] },
  { id: 'pdf.copyText', messageKey: 'pdfCopyText', scope: 'pdf', when: 'pdf.open', bindings: [] }
]

const SHORTCUT_BY_ID = new Map(SHORTCUTS.map(shortcut => [shortcut.id, shortcut]))
const MARKDOWN_NATIVE_BINDINGS: Partial<Record<ShortcutCommandId, readonly ShortcutBinding[]>> = {
  'markdown.redo': binding('y'),
  'markdown.strikethrough': binding('x', ['primary', 'alt']),
  'markdown.inlineCode': binding('e'),
  'markdown.paragraph': binding('0', ['primary', 'alt']),
  'markdown.heading1': binding('1', ['primary', 'alt']),
  'markdown.heading2': binding('2', ['primary', 'alt']),
  'markdown.heading3': binding('3', ['primary', 'alt']),
  'markdown.heading4': binding('4', ['primary', 'alt']),
  'markdown.heading5': binding('5', ['primary', 'alt']),
  'markdown.heading6': binding('6', ['primary', 'alt'])
}

export function shortcutDefinition(id: ShortcutCommandId): ShortcutDefinition {
  const shortcut = SHORTCUT_BY_ID.get(id)
  if (!shortcut) throw new Error(`Unknown shortcut command: ${id}`)
  return shortcut
}

export function shortcutBindings(id: ShortcutCommandId): readonly ShortcutBinding[] {
  return shortcutDefinition(id).bindings
}

export function effectiveShortcutBindings(
  id: ShortcutCommandId,
  overrides: ShortcutOverrides = activeShortcutOverrides
): readonly ShortcutBinding[] {
  if (!Object.prototype.hasOwnProperty.call(overrides, id)) return shortcutBindings(id)
  const override = overrides[id]
  return override ? [override] : []
}

export function setActiveShortcutOverrides(overrides: ShortcutOverrides): void {
  activeShortcutOverrides = overrides
}

export function shortcutBinding(id: ShortcutCommandId): ShortcutBinding {
  const [first] = shortcutBindings(id)
  if (!first) throw new Error(`Shortcut command has no binding: ${id}`)
  return first
}

function hasModifier(bindingValue: ShortcutBinding, modifier: ShortcutModifier): boolean {
  return bindingValue.modifiers.includes(modifier)
}

export function shortcutPlatform(userAgent: string): ShortcutPlatform {
  return /Mac|iPhone|iPad/i.test(userAgent) ? 'mac' : 'windows'
}

export function currentShortcutPlatform(): ShortcutPlatform {
  return shortcutPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent)
}

export function matchesBinding(
  event: ShortcutEvent,
  bindingValue: ShortcutBinding,
  platform: ShortcutPlatform = currentShortcutPlatform()
): boolean {
  const primaryPressed = platform === 'mac'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  const eventKey = event.key === ' ' ? 'Space' : event.key
  return eventKey.toLowerCase() === bindingValue.key.toLowerCase()
    && primaryPressed === hasModifier(bindingValue, 'primary')
    && event.shiftKey === hasModifier(bindingValue, 'shift')
    && event.altKey === hasModifier(bindingValue, 'alt')
}

export function matchesShortcut(
  event: ShortcutEvent,
  id: ShortcutCommandId,
  platform: ShortcutPlatform = currentShortcutPlatform(),
  overrides: ShortcutOverrides = activeShortcutOverrides
): boolean {
  return effectiveShortcutBindings(id, overrides).some(bindingValue => matchesBinding(event, bindingValue, platform))
}

export function resolveShortcut(
  event: ShortcutEvent,
  activeScopes: readonly ShortcutScope[],
  platform: ShortcutPlatform = currentShortcutPlatform(),
  overrides: ShortcutOverrides = activeShortcutOverrides
): ShortcutDefinition | undefined {
  const scopePriority = new Map(activeScopes.map((scope, index) => [scope, index]))
  return SHORTCUTS
    .filter(shortcut => scopePriority.has(shortcut.scope) && effectiveShortcutBindings(shortcut.id, overrides).some(bindingValue => matchesBinding(event, bindingValue, platform)))
    .sort((left, right) => (
      (scopePriority.get(left.scope) ?? Number.MAX_SAFE_INTEGER)
      - (scopePriority.get(right.scope) ?? Number.MAX_SAFE_INTEGER)
    ))[0]
}

export function resolveMarkdownShortcut(
  event: ShortcutEvent,
  platform: ShortcutPlatform = currentShortcutPlatform(),
  overrides: ShortcutOverrides = activeShortcutOverrides
): ShortcutDefinition | undefined {
  return resolveShortcut(event, ['markdown'], platform, overrides)
}

export function suppressMarkdownDefaultShortcut(
  event: ShortcutEvent,
  platform: ShortcutPlatform = currentShortcutPlatform()
): boolean {
  return SHORTCUTS.some(shortcut => (
    shortcut.scope === 'markdown'
    && [...shortcut.bindings, ...(MARKDOWN_NATIVE_BINDINGS[shortcut.id] ?? [])]
      .some(bindingValue => matchesBinding(event, bindingValue, platform))
  ))
}

function normalizedBinding(bindingValue: ShortcutBinding): string {
  return `${[...bindingValue.modifiers].sort().join('+')}:${bindingValue.key.toLocaleLowerCase()}`
}

export function findShortcutConflicts(
  id: ShortcutCommandId,
  bindingValue: ShortcutBinding,
  overrides: ShortcutOverrides
): ShortcutCommandId[] {
  const definition = shortcutDefinition(id)
  const normalized = normalizedBinding(bindingValue)
  return SHORTCUTS.filter(candidate => (
    candidate.id !== id
    && candidate.scope === definition.scope
    && effectiveShortcutBindings(candidate.id, overrides).some(binding => normalizedBinding(binding) === normalized)
  )).map(candidate => candidate.id)
}

export function recordShortcutBinding(
  event: ShortcutEvent,
  platform: ShortcutPlatform = currentShortcutPlatform()
): ShortcutBinding | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined
  const primaryPressed = platform === 'mac'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if ((platform === 'mac' && event.ctrlKey) || (platform === 'windows' && event.metaKey)) return undefined
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLocaleLowerCase() : event.key
  if (primaryPressed && RESERVED_PRIMARY_KEYS[platform].has(key.toLocaleLowerCase())) return undefined
  const modifiers: ShortcutModifier[] = []
  if (primaryPressed) modifiers.push('primary')
  if (event.shiftKey) modifiers.push('shift')
  if (event.altKey) modifiers.push('alt')
  if (!isPreferenceShortcutBindingAllowed(key, modifiers)) return undefined
  return { key, modifiers }
}

export function formatShortcut(bindingValue: ShortcutBinding, platform: ShortcutPlatform): string {
  const key = SHORTCUT_KEY_LABELS[bindingValue.key]
    ?? (bindingValue.key.length === 1 ? bindingValue.key.toUpperCase() : bindingValue.key)
  const showShift = hasModifier(bindingValue, 'shift') && bindingValue.key !== '+'
  if (platform === 'mac') {
    return `${showShift ? '⇧' : ''}${hasModifier(bindingValue, 'alt') ? '⌥' : ''}${hasModifier(bindingValue, 'primary') ? '⌘' : ''}${key}`
  }
  return [
    hasModifier(bindingValue, 'primary') ? 'Ctrl' : null,
    showShift ? 'Shift' : null,
    hasModifier(bindingValue, 'alt') ? 'Alt' : null,
    key
  ].filter(Boolean).join('+')
}
