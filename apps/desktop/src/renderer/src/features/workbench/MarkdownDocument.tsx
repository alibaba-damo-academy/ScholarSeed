import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

import { EditorView as CodeEditorView } from '@codemirror/view'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { toggleLinkCommand as openLinkEditorCommand } from '@milkdown/kit/component/link-tooltip'
import { commandsCtx, editorViewCtx, parserCtx, remarkCtx, schemaCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { Slice, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { selectAll } from '@milkdown/kit/prose/commands'
import {
  blockquoteSchema,
  bulletListSchema,
  orderedListSchema,
  clearTextInCurrentBlockCommand,
  emphasisSchema,
  headingSchema,
  inlineCodeSchema,
  isMarkSelectedCommand,
  isNodeSelectedCommand,
  linkSchema,
  paragraphSchema,
  setBlockTypeCommand,
  strongSchema
} from '@milkdown/kit/preset/commonmark'
import { strikethroughSchema } from '@milkdown/kit/preset/gfm'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history'
import { replaceAll } from '@milkdown/kit/utils'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import React, { type ReactNode, type RefCallback, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, Undo2 } from 'lucide-react'

import { Alert, BadgeDot, Button, Dialog, DialogPortal, DialogContent, DialogFooter, DialogHeader, DialogTitle, IconButton, SearchBox, Tabs, TabsList, TabsTrigger, Tooltip, useToast } from '../../components/ui'
import { writeClipboard } from '../../components/primitive/clipboard'
import { useApp } from '../../store'
import {
  useSelectionActionContribution,
  type SelectionReplacement
} from './actions'
import type { CitationResolution } from '../../contracts/citations'
import { configureCitationLinks, DOCUMENT_FRAGMENT_ATTRIBUTE, savedCitationPlugin } from './citations'
import { markdownFragmentTarget, normalizeMarkdownTargetText } from './anchors'
import { preserveMarkdownReadingPosition } from './reading'
import { useImageFailureText } from './failure'
import { formatTextOnSave } from './format'
import { encodeTextForSave } from './text'
import { createMarkdownImageResolver, persistMarkdownImage, resolveSavedCitation } from './api'
import { sealResourceSnapshot } from '../../contracts/resources'
import { resolveMarkdownShortcut, suppressMarkdownDefaultShortcut, type ShortcutCommandId } from '../../shortcuts'
import { codeLanguageLabel, installMathBlockInteraction, literalLatexSchema, mathCompatibilityPlugin } from './mathematics'
import { MonacoDocument } from './MonacoDocument'
import { markdownSourceRange, whitespaceSelection, type MarkdownSyntaxNode } from './mapping'
import { tableColumnInheritancePlugin } from './table'
import {
  selectionFingerprint,
  selectionViewport,
  useDocumentWorkspace,
  useWorkspaceController,
  type DocumentViewKind
} from './workspace'

const EDITOR_CONTENT_SELECTOR = '.ProseMirror'
const FRAGMENT_HIGHLIGHT_DURATION_MS = 1
const MARKDOWN_PAPER_CLASS = '!mx-auto !my-[var(--vds-space-6)] flex min-h-[calc(100%_-_var(--vds-space-6)*2)] w-[calc(100%_-_var(--vds-space-6)*2)] max-w-none flex-col rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] !px-[calc(var(--vds-space-8)*2)] !py-[calc(var(--vds-space-8)*2)] shadow-[var(--vds-shadow-1-center)] [--crepe-font-default:var(--vds-font-main)] [--crepe-font-title:var(--vds-font-main)] [@container(max-width:760px)]:!mx-[var(--vds-space-3)] [@container(max-width:760px)]:!my-[var(--vds-space-3)] [@container(max-width:760px)]:w-[calc(100%_-_var(--vds-space-3)*2)] [@container(max-width:760px)]:!px-[var(--vds-space-8)] [@container(max-width:760px)]:!py-[var(--vds-space-8)] [&>.ProseMirror]:!m-0 [&>.ProseMirror]:!w-full [&>.ProseMirror]:!min-h-0 [&>.ProseMirror]:!flex-1 [&>.ProseMirror]:!border-0 [&>.ProseMirror]:!p-0 [&>.ProseMirror]:!outline-none [&>.ProseMirror]:!shadow-none [&>.ProseMirror]:!bg-transparent [&>.ProseMirror]:text-[var(--vds-text-primary)] [&>.ProseMirror]:text-[length:var(--vds-font-body-lv2)] [&>.ProseMirror]:leading-[var(--vds-lh-body-lv2)] [&>.ProseMirror]:![font-family:var(--vds-font-main)] [&>.ProseMirror]:![font-weight:var(--vds-fw-regular)] [&>.ProseMirror_:is(h1,h2,h3,h4,h5,h6)]:![font-weight:var(--vds-fw-semibold)] [&>.ProseMirror>:nth-child(1_of_:not(.ProseMirror-widget,.prosemirror-virtual-cursor))]:!mt-0'

const SOURCE_MAP_VERSION = 'milkdown-source-map-v3'
const CODE_EDITOR_SELECTOR = '.cm-editor'
const CODE_CONTENT_SELECTOR = '.cm-content'
const CODE_COPY_BUTTON_SELECTOR = '.milkdown-code-block .copy-button'
const CODE_BLOCK_SELECTOR = '.milkdown-code-block'
const ATOM_VALUE_ATTRIBUTE = 'value'
const RENDERED_BLOCK_SEPARATOR = ''
const SELECTION_TEXT_SEPARATOR = '\n'
const EMPTY_ICON = '<span aria-hidden="true"></span>'
const SLASH_MENU_SELECTOR = '.milkdown-slash-menu'
const EDITOR_ACTION_SELECTOR = 'button,[role="button"],[role="menuitem"]'
const INLINE_MATH_NODE = 'math_inline'
const TOGGLE_INLINE_MATH_COMMAND = 'ToggleLatex'
const MARKDOWN_FORMAT_SHORTCUTS: Partial<Record<ShortcutCommandId, string>> = {
  'markdown.bold': 'bold',
  'markdown.inlineCode': 'code',
  'markdown.italic': 'italic',
  'markdown.link': 'link',
  'markdown.strikethrough': 'strikethrough'
}
const MARKDOWN_HEADING_SHORTCUTS: Partial<Record<ShortcutCommandId, number | null>> = {
  'markdown.paragraph': null,
  'markdown.heading1': 1,
  'markdown.heading2': 2,
  'markdown.heading3': 3,
  'markdown.heading4': 4,
  'markdown.heading5': 5,
  'markdown.heading6': 6
}

interface MarkdownFormatState {
  bold: boolean
  code: boolean
  italic: boolean
  latex: boolean
  link: boolean
  strike: boolean
}

interface MarkdownFindResult {
  current: number
  total: number
}

const FORMAT_ACTIONS = [
  { key: 'bold', labelKey: 'markdown.bold', stateKey: 'bold' },
  { key: 'italic', labelKey: 'markdown.italic', stateKey: 'italic' },
  { key: 'strikethrough', labelKey: 'markdown.strike', stateKey: 'strike' },
  { key: 'link', labelKey: 'markdown.link', stateKey: 'link' },
  { key: 'code', labelKey: 'markdown.inlineCode', stateKey: 'code' },
  { key: 'math', labelKey: 'markdown.inlineMath', stateKey: 'latex' }
] as const

const EMPTY_FORMAT_STATE: MarkdownFormatState = {
  bold: false,
  code: false,
  italic: false,
  latex: false,
  link: false,
  strike: false
}

function markdownTextMatches(documentNode: ProseNode, query: string): Array<{ from: number; to: number }> {
  const normalizedQuery = query.toLocaleLowerCase()
  if (!normalizedQuery) return []
  const matches: Array<{ from: number; to: number }> = []
  documentNode.descendants((node, position) => {
    if (!node.isTextblock) return true
    let text = ''
    const positions: number[] = []
    node.forEach((child, offset) => {
      if (!child.isText) return
      const childText = child.text ?? ''
      for (let index = 0; index < childText.length; index++) positions.push(position + 1 + offset + index)
      text += childText
    })
    const normalizedText = text.toLocaleLowerCase()
    let offset = 0
    while (offset <= normalizedText.length - normalizedQuery.length) {
      const found = normalizedText.indexOf(normalizedQuery, offset)
      if (found < 0) break
      const from = positions[found]
      const last = positions[found + normalizedQuery.length - 1]
      if (from !== undefined && last !== undefined) matches.push({ from, to: last + 1 })
      offset = found + Math.max(1, normalizedQuery.length)
    }
    return false
  })
  return matches
}

function occurrenceStarts(source: string, selected: string): number[] {
  const starts: number[] = []
  let offset = 0
  while (offset <= source.length - selected.length) {
    const found = source.indexOf(selected, offset)
    if (found < 0) break
    starts.push(found)
    offset = found + Math.max(1, selected.length)
  }
  return starts
}

function occurrenceCount(source: string, selected: string): number {
  return occurrenceStarts(source, selected).length
}

/** Text a document node contributes to the rendered stream, including atom Markdown values. */
function renderedLeafText(node: ProseNode): string {
  const text = node.type.spec.leafText?.(node)
  if (text !== undefined) return text
  const value: unknown = node.attrs[ATOM_VALUE_ATTRIBUTE]
  return typeof value === 'string' ? value : ''
}

function codeBlockStart(view: EditorView, code: CodeEditorView, position: number): number | null {
  const resolved = view.state.doc.resolve(position)
  const candidates = [
    resolved.depth > 0 ? resolved.before() : null,
    position,
    resolved.nodeBefore ? position - resolved.nodeBefore.nodeSize : null
  ]
  for (const candidate of candidates) {
    if (candidate === null) continue
    const block = view.state.doc.nodeAt(candidate)
    if (
      block?.isTextblock
      && block.content.size === code.state.doc.length
      && view.nodeDOM(candidate)?.contains(code.dom)
    ) return candidate
  }
  return null
}

function copyButtonFromTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(CODE_COPY_BUTTON_SELECTOR) : null
}

function codeBlockCopyText(copyButton: HTMLElement): string | null {
  const editorHost = copyButton.closest<HTMLElement>(CODE_BLOCK_SELECTOR)
    ?.querySelector<HTMLElement>(CODE_EDITOR_SELECTOR)
  if (!editorHost) return null
  try {
    return CodeEditorView.findFromDOM(editorHost)?.state.doc.toString() ?? null
  } catch {
    return null
  }
}

/** Resolve a DOM point, using an embedded code editor's own coordinates inside code blocks. */
function editorPositionAtDOM(view: EditorView, node: Node, offset: number): number {
  const position = view.posAtDOM(node, offset)
  const element = node instanceof Element ? node : node.parentElement
  const content = element?.closest<HTMLElement>(CODE_CONTENT_SELECTOR)
  const host = content?.closest<HTMLElement>(CODE_EDITOR_SELECTOR)
  const code = host && view.dom.contains(host) ? CodeEditorView.findFromDOM(host) : null
  if (!code) return position
  // A node view without contentDOM reports a point before, inside or after its block.
  const start = codeBlockStart(view, code, position)
  if (start !== null) return start + 1 + code.posAtDOM(node, offset)
  return position
}

function editorPositionAtPoint(
  view: EditorView,
  host: HTMLElement | null,
  point: { x: number; y: number } | null
): number | null {
  if (!point) return null
  if (!host) return view.posAtCoords({ left: point.x, top: point.y })?.pos ?? null
  if (!view.dom.contains(host)) return null
  const code = CodeEditorView.findFromDOM(host)
  if (!code) return null
  const position = view.posAtDOM(host, 0)
  const start = codeBlockStart(view, code, position)
  const codePosition = code.posAtCoords(point)
  return start === null || codePosition === null ? null : start + 1 + codePosition
}

function syncCodeEditorSelections(
  view: EditorView,
  selection: { anchor: number; focus: number } | null
): void {
  const selectionFrom = selection ? Math.min(selection.anchor, selection.focus) : null
  const selectionTo = selection ? Math.max(selection.anchor, selection.focus) : null
  const forward = selection ? selection.anchor <= selection.focus : true
  view.dom.querySelectorAll<HTMLElement>(CODE_EDITOR_SELECTOR).forEach((host) => {
    const code = CodeEditorView.findFromDOM(host)
    if (!code) return
    const start = codeBlockStart(view, code, view.posAtDOM(host, 0))
    if (start === null) return
    const blockFrom = start + 1
    const blockTo = blockFrom + code.state.doc.length
    const from = selectionFrom === null ? blockFrom : Math.max(selectionFrom, blockFrom)
    const to = selectionTo === null ? blockFrom : Math.min(selectionTo, blockTo)
    const current = code.state.selection.main
    if (from < to) {
      const localFrom = from - blockFrom
      const localTo = to - blockFrom
      const anchor = forward ? localFrom : localTo
      const head = forward ? localTo : localFrom
      if (current.anchor !== anchor || current.head !== head) {
        code.dispatch({ selection: { anchor, head } })
      }
    } else if (!current.empty) {
      code.dispatch({ selection: { anchor: current.head } })
    }
  })
}

function syncCodeEditorPointerSelection(
  view: EditorView,
  start: { host: HTMLElement | null; x: number; y: number },
  host: HTMLElement | null,
  point: { x: number; y: number }
): void {
  const anchor = editorPositionAtPoint(view, start.host, start)
  const focus = editorPositionAtPoint(view, host, point)
  if (anchor === null || focus === null || anchor === focus) return
  syncCodeEditorSelections(view, { anchor, focus })
}

const HEADING_OPTIONS = [
  { labelKey: 'markdown.body', level: null },
  { labelKey: 'markdown.h1', level: 1 },
  { labelKey: 'markdown.h2', level: 2 },
  { labelKey: 'markdown.h3', level: 3 },
  { labelKey: 'markdown.h4', level: 4 },
  { labelKey: 'markdown.h5', level: 5 },
  { labelKey: 'markdown.h6', level: 6 }
] as const

function SaveFeedback({ saved }: { saved: boolean }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return <>{saved ? t('markdown.saved') : t('markdown.saveFailed')}</>
}

function MarkdownHeader({
  sessionId,
  tabId,
  viewKind,
  editorActionsRef,
  toolbarActions,
  visualDisabled
}: {
  sessionId: string
  tabId: string
  viewKind: DocumentViewKind
  editorActionsRef: RefCallback<HTMLDivElement>
  toolbarActions?: ReactNode
  visualDisabled: boolean
}): React.JSX.Element {
  const session = useDocumentWorkspace().sessions[sessionId]
  const workspace = useWorkspaceController()
  const { toast } = useToast()
  const { t } = useTranslation('workbench')
  const externalPending = session?.source.kind === 'project'
    && session.source.project
    && session.versioning?.pending?.origin === 'external'
    && !session.versioning.pending.review
    ? session.versioning
    : null
  const switchView = (target: DocumentViewKind): void => {
    if (target === 'edit' && visualDisabled) return
    workspace.setTabView(tabId, target)
  }
  const saveDocument = (): void => {
    if (session?.source.kind === 'project' && session.source.project && externalPending && !session.dirty) {
      void sealResourceSnapshot(
        session.source.project,
        session.source.path,
        externalPending,
        crypto.randomUUID(),
        'external_confirmed'
      ).then(async (result) => {
        if (result.ok) await workspace.refreshVersioning(sessionId, session.documentId)
        toast({ title: <SaveFeedback saved={result.ok} />, tone: result.ok ? 'success' : 'error' })
      })
      return
    }
    void workspace.save(sessionId).then((saved) => {
      toast({ title: <SaveFeedback saved={saved} />, tone: saved ? 'success' : 'error' })
    })
  }
  const savePending = Boolean(session?.dirty || externalPending)
  return (
    <div className="vds-markdown-header flex min-h-12 min-w-0 flex-nowrap items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-gray-default)] px-[var(--vds-space-4)] py-[var(--vds-space-1)]" data-save-state={session?.saveState ?? 'clean'}>
      <div className={`${viewKind === 'edit' ? 'vds-markdown-crepe ' : ''}flex min-w-0 flex-1 items-center overflow-hidden`}>
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <div
            ref={editorActionsRef}
            className={viewKind === 'edit'
              ? 'milkdown flex min-w-0 flex-1 items-center overflow-hidden !bg-transparent [&>.milkdown-top-bar]:!static [&>.milkdown-top-bar]:!z-auto [&>.milkdown-top-bar]:!min-h-0 [&>.milkdown-top-bar]:!min-w-0 [&>.milkdown-top-bar]:!flex-1 [&>.milkdown-top-bar]:!flex-nowrap [&>.milkdown-top-bar]:!overflow-x-auto [&>.milkdown-top-bar]:!border-0 [&>.milkdown-top-bar]:!bg-transparent [&>.milkdown-top-bar]:!p-0 [&>.milkdown-top-bar>.top-bar-inner]:!w-max [&>.milkdown-top-bar>.top-bar-inner]:!flex-nowrap [&>.milkdown-top-bar>.top-bar-inner]:!gap-[var(--vds-toolbar-icon-gap)] [&>.milkdown-top-bar_.top-bar-divider]:!h-[var(--vds-icon-8)] [&>.milkdown-top-bar_.top-bar-divider]:!mx-[var(--vds-toolbar-divider-margin)] [&>.milkdown-top-bar_.top-bar-item]:!size-[var(--vds-control-height-sm)] [&>.milkdown-top-bar_.top-bar-item]:!p-[var(--vds-toolbar-divider-margin)] [&>.milkdown-top-bar_.top-bar-item]:!text-[length:var(--vds-font-body-lv2)] [&>.milkdown-top-bar_.top-bar-item_svg]:!size-[var(--vds-icon-7)]'
              : 'flex min-w-0 flex-1 items-center'}
            data-testid="markdown-editor-actions"
          />
        </div>
      </div>
      {visualDisabled && (
        <span className="min-w-0 truncate text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
          {t('markdown.large')}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)]">
        <Tabs
          className="flex-none"
          value={viewKind}
          aria-label={t('markdown.view')}
          onValueChange={(target) => {
            if (target === 'preview' || target === 'edit') switchView(target)
          }}
        >
          <TabsList>
            <TabsTrigger value="preview" data-testid="markdown-open-source">
              {t('markdown.source')}
            </TabsTrigger>
            <TabsTrigger
              value="edit"
              data-testid="markdown-open-editor"
              disabled={visualDisabled}
              title={visualDisabled ? t('markdown.largeHint') : undefined}
            >
              {t('markdown.edit')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {toolbarActions}
        <Tooltip portalled content={t('markdown.save')}>
          <span className="relative inline-flex">
            <IconButton
              variant="ghostIcon"
              size="sm"
              title={undefined}
              label={t('markdown.save')}
              icon={<Save />}
              data-testid="markdown-save"
              data-external-change={externalPending ? 'true' : undefined}
              disabled={!savePending || session?.saveState === 'saving'
                || (session?.dirty ? !session.capabilities.can_save : !externalPending?.can_version)}
              onClick={saveDocument}
            />
            {savePending && <BadgeDot className="pointer-events-none absolute right-0 top-0" data-testid="markdown-save-dirty" />}
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

function MarkdownVisualEditor({
  formatOnSave,
  sessionId,
  tabId,
  toolbarHost
}: {
  formatOnSave: boolean
  sessionId: string
  tabId: string
  toolbarHost: HTMLElement | null
}): React.JSX.Element {
  const state = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const session = state.sessions[sessionId]
  const [uploadError, setUploadError] = useState<{ cause: unknown } | null>(null)
  const { toast } = useToast()
  const imageFailureText = useImageFailureText()
  const { t, i18n } = useTranslation('workbench')
  const requestedLanguage = i18n.resolvedLanguage === 'en' ? 'en' : 'zh'
  const [editorLanguage] = useState(requestedLanguage)
  const { t: citationText } = useTranslation('components')
  const [citation, setCitation] = useState<CitationResolution | null>(null)
  const [citationError, setCitationError] = useState(false)
  const [fragmentReturnAvailable, setFragmentReturnAvailable] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<MarkdownFindResult | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const fragmentReturnRef = useRef<{ top: number; left: number } | null>(null)
  const fragmentHighlightRef = useRef<Animation | null>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const crepeReadyRef = useRef(false)
  const applyingExternalRef = useRef(false)
  const externallyAppliedMarkdownRef = useRef<string | null>(null)
  const projectedMarkdownRef = useRef('')
  const userEditPendingRef = useRef(false)
  const syntaxTreeRef = useRef<{ source: string; tree: MarkdownSyntaxNode } | null>(null)
  const nativeSelectionRef = useRef<{
    changeVersion: number
    fingerprint: string
    from: number
    text: string
    to: number
  } | null>(null)
  const pointerStartRef = useRef<{ host: HTMLElement | null; x: number; y: number } | null>(null)
  const [formatActions, setFormatActions] = useState<{
    key: string
    labelKey: (typeof FORMAT_ACTIONS)[number]['labelKey']
    stateKey: keyof MarkdownFormatState
    icon: string
    onRun: (ctx: Ctx) => void
  }[]>([])

  const [formatState, setFormatState] = useState(EMPTY_FORMAT_STATE)
  const latestTextRef = useRef(session?.text ?? '')
  latestTextRef.current = session?.text ?? ''

  const clearFragmentTarget = useCallback((): void => {
    fragmentHighlightRef.current?.cancel()
    fragmentHighlightRef.current = null
  }, [])

  const navigateFragment = useCallback((href: string): boolean => {
    const target = markdownFragmentTarget(latestTextRef.current, href)
    const host = hostRef.current
    const content = host?.querySelector<HTMLElement>(EDITOR_CONTENT_SELECTOR)
    const scroller = host?.querySelector<HTMLElement>(':scope > .milkdown')
    if (!target || !content || !scroller) return false
    const targetText = normalizeMarkdownTargetText(target.text)
    const findTarget = (): HTMLElement | undefined => Array.from(content.children).find(child => {
      const text = normalizeMarkdownTargetText(child.textContent ?? '')
      return text.length > 0
        && (text === targetText || text.startsWith(targetText) || targetText.startsWith(text))
    }) as HTMLElement | undefined
    const element = findTarget()
    if (!element) return false
    clearFragmentTarget()
    fragmentReturnRef.current = { top: scroller.scrollTop, left: scroller.scrollLeft }
    setFragmentReturnAvailable(true)
    window.requestAnimationFrame(() => {
      const currentElement = findTarget()
      if (!currentElement) return
      fragmentHighlightRef.current = currentElement.animate({
        backgroundColor: 'var(--vds-pdf-citation-highlight)',
        borderRadius: 'var(--vds-radius-2)',
        boxShadow: '0 0 0 2px var(--vds-notice-border-default)'
      }, { duration: FRAGMENT_HIGHLIGHT_DURATION_MS, fill: 'forwards' })
      currentElement.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    return true
  }, [clearFragmentTarget])

  const returnToFragmentSource = useCallback((): void => {
    const scroller = hostRef.current?.querySelector<HTMLElement>(':scope > .milkdown')
    const position = fragmentReturnRef.current
    if (!scroller || !position) return
    scroller.scrollTo({ top: position.top, left: position.left })
    fragmentReturnRef.current = null
    setFragmentReturnAvailable(false)
    clearFragmentTarget()
  }, [clearFragmentTarget])

  const replaceExternalText = useCallback((crepe: Crepe, text: string): void => {
    let anchor = 1
    let head = 1
    let focused = false
    const scrollTop = hostRef.current?.scrollTop ?? 0
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      anchor = view.state.selection.anchor
      head = view.state.selection.head
      focused = view.hasFocus()
    })
    applyingExternalRef.current = true
    try {
      crepe.editor.action(replaceAll(text))
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const lastPosition = Math.max(1, view.state.doc.content.size)
        view.dispatch(view.state.tr.setSelection(TextSelection.between(
          view.state.doc.resolve(Math.min(anchor, lastPosition)),
          view.state.doc.resolve(Math.min(head, lastPosition))
        )))
        if (focused) view.focus()
      })
      const markdown = crepe.getMarkdown()
      externallyAppliedMarkdownRef.current = markdown
      projectedMarkdownRef.current = markdown
      userEditPendingRef.current = false
    } finally {
      applyingExternalRef.current = false
    }
    if (hostRef.current) hostRef.current.scrollTop = scrollTop
  }, [])

  const markUserEdit = useCallback((): void => {
    userEditPendingRef.current = true
  }, [])

  const commitVisualEdit = useCallback((markdown: string): void => {
    if (!userEditPendingRef.current) return
    userEditPendingRef.current = false
    if (markdown === projectedMarkdownRef.current) return
    projectedMarkdownRef.current = markdown
    externallyAppliedMarkdownRef.current = null
    workspace.updateText(sessionId, markdown)
  }, [sessionId, workspace])

  const refreshFormatState = useCallback((): void => {
    const crepe = crepeRef.current
    if (!crepe || !crepeReadyRef.current) return
    crepe.editor.action((ctx) => {
      const commands = ctx.get(commandsCtx)
      const mathInline = ctx.get(schemaCtx).nodes[INLINE_MATH_NODE]
      setFormatState({
        bold: commands.call(isMarkSelectedCommand.key, strongSchema.type(ctx)),
        code: commands.call(isMarkSelectedCommand.key, inlineCodeSchema.type(ctx)),
        italic: commands.call(isMarkSelectedCommand.key, emphasisSchema.type(ctx)),
        latex: Boolean(mathInline && commands.call(isNodeSelectedCommand.key, mathInline)),
        link: commands.call(isMarkSelectedCommand.key, linkSchema.type(ctx)),
        strike: commands.call(isMarkSelectedCommand.key, strikethroughSchema.type(ctx))
      })
    })
  }, [])

  const runFormat = useCallback((run: (ctx: Ctx) => void): void => {
    const crepe = crepeRef.current
    if (!crepe || !crepeReadyRef.current) return
    markUserEdit()
    crepe.editor.action((ctx) => {
      run(ctx)
      ctx.get(editorViewCtx).focus()
    })
    refreshFormatState()
  }, [markUserEdit, refreshFormatState])

  const runFind = useCallback((direction: 1 | -1): void => {
    const crepe = crepeRef.current
    if (!crepe || !crepeReadyRef.current || !findQuery) {
      setFindResult(null)
      return
    }
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const matches = markdownTextMatches(view.state.doc, findQuery)
      if (!matches.length) {
        setFindResult({ current: 0, total: 0 })
        return
      }
      const selection = view.state.selection
      let nextIndex = direction > 0
        ? matches.findIndex(match => match.from >= selection.to)
        : -1
      if (direction < 0) {
        for (let index = matches.length - 1; index >= 0; index--) {
          if (matches[index].to <= selection.from) {
            nextIndex = index
            break
          }
        }
      }
      const index = nextIndex >= 0 ? nextIndex : direction > 0 ? 0 : matches.length - 1
      const match = matches[index]
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView())
      setFindResult({ current: index + 1, total: matches.length })
    })
  }, [findQuery])

  const closeFind = useCallback((): void => {
    setFindOpen(false)
    crepeRef.current?.editor.action(ctx => ctx.get(editorViewCtx).focus())
  }, [])

  const runMarkdownShortcut = useCallback((id: ShortcutCommandId): void => {
    if (id === 'markdown.save') {
      void workspace.save(sessionId)
      return
    }
    if (id === 'markdown.find') {
      setFindOpen(true)
      requestAnimationFrame(() => findInputRef.current?.focus())
      return
    }
    const crepe = crepeRef.current
    if (!crepe || !crepeReadyRef.current) return
    if (id === 'markdown.selectAll') {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        selectAll(view.state, view.dispatch)
        view.focus()
      })
      return
    }
    if (id === 'markdown.undo' || id === 'markdown.redo') {
      runFormat((ctx) => {
        ctx.get(commandsCtx).call(id === 'markdown.undo' ? undoCommand.key : redoCommand.key)
      })
      return
    }
    const formatKey = MARKDOWN_FORMAT_SHORTCUTS[id]
    if (formatKey) {
      const action = formatActions.find(candidate => candidate.key === formatKey)
      if (action) runFormat(action.onRun)
      return
    }
    if (Object.prototype.hasOwnProperty.call(MARKDOWN_HEADING_SHORTCUTS, id)) {
      const level = MARKDOWN_HEADING_SHORTCUTS[id]
      runFormat((ctx) => {
        ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
          nodeType: level === null ? paragraphSchema.type(ctx) : headingSchema.type(ctx),
          attrs: level === null ? undefined : { level }
        })
      })
    }
  }, [formatActions, runFormat, sessionId, workspace])

  const replaceSelection = useCallback<SelectionReplacement>(async (request) => {
    const crepe = crepeRef.current
    const captured = nativeSelectionRef.current
    const current = workspace.getSnapshot().sessions[sessionId]
    if (
      !crepe
      || !crepeReadyRef.current
      || !captured
      || !current
      || current.changeVersion !== request.expectedChangeVersion
      || captured.changeVersion !== request.expectedChangeVersion
      || captured.fingerprint !== request.expectedFingerprint
      || selectionFingerprint(request.selection) !== request.expectedFingerprint
    ) return { ok: false, error: 'selection_changed' }
    let replaced = false
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const selected = view.state.doc.textBetween(captured.from, captured.to, '\n')
      if (selected !== captured.text) return
      markUserEdit()
      const parsed = ctx.get(parserCtx)(request.replacement)
      const replacement = Slice.maxOpen(parsed.content)
      view.dispatch(view.state.tr.replaceRange(captured.from, captured.to, replacement).scrollIntoView())
      replaced = true
    })
    return replaced ? { ok: true } : { ok: false, error: 'selection_changed' }
  }, [markUserEdit, sessionId, workspace])

  const selectionActions = useMemo(() => ({
    actions: (
      <>
        {formatActions.map((action) => (
          <Button
            key={action.key}
            aria-label={t(action.labelKey)}
            aria-pressed={formatState[action.stateKey]}
            variant="ghost"
            className="!h-9 !min-h-9 !w-9 !min-w-9 !shrink-0 !rounded-[6px] !border-0 !p-[6px] !text-base !font-medium !text-[var(--vds-text-primary)] !shadow-none hover:!bg-[var(--vds-bg-white-default)] aria-pressed:!bg-[var(--vds-bg-white-default)]"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runFormat(action.onRun)}
          >
            <span className="inline-flex items-center justify-center [&_svg]:h-6 [&_svg]:w-6 [&_svg]:fill-current" aria-hidden="true" dangerouslySetInnerHTML={{ __html: action.icon }} />
          </Button>
        ))}
      </>
    ),
    expanded: false,
    id: 'markdown-format',
    order: 200,
    replaceSelection
  }), [formatActions, formatState, replaceSelection, runFormat, t])
  useSelectionActionContribution(tabId, selectionActions)

  useEffect(() => {
    if (!hostRef.current || !toolbarHost || !session || session.text === null || session.loadState !== 'ready') return

    const initialText = session.text
    const t = i18n.getFixedT(editorLanguage, 'workbench')
    const imageResolver = createMarkdownImageResolver(session.source)
    const crepe = new Crepe({
      root: hostRef.current,
      defaultValue: session.text,
      features: {
        [CrepeFeature.TopBar]: true,
        [CrepeFeature.Toolbar]: false,
        [CrepeFeature.AI]: false
      },
      featureConfigs: {
        [CrepeFeature.ImageBlock]: {
          inlineUploadButton: t('markdown.uploadImage'),
          inlineUploadPlaceholderText: t('markdown.pasteImageLink'),
          blockUploadButton: t('markdown.uploadImageFile'),
          blockConfirmButton: t('markdown.confirmImage'),
          blockCaptionPlaceholderText: t('markdown.imageCaptionPlaceholder'),
          blockUploadPlaceholderText: t('markdown.pasteImageLink'),
          onUpload: async (file) => {
            setUploadError(null)
            try {
              return await persistMarkdownImage(session.source, file)
            } catch (error) {
              setUploadError({ cause: error })
              throw error
            }
          },
          proxyDomURL: (url) => imageResolver.resolve(url)
        },
        [CrepeFeature.CodeMirror]: {
          previewOnlyByDefault: true,
          renderLanguage: (language) => codeLanguageLabel(language, t('markdown.literalLatex')),
          searchPlaceholder: t('markdown.searchLanguage'),
          copyText: t('markdown.codeCopy'),
          noResultText: t('markdown.codeNoResults'),
          previewToggleText: (previewOnlyMode) => previewOnlyMode ? t('markdown.edit') : t('markdown.codeHide'),
          previewLabel: t('markdown.codePreview'),
          previewLoading: t('markdown.codeLoading')
        },
        [CrepeFeature.LinkTooltip]: { inputPlaceholder: t('markdown.pasteLink') },
        [CrepeFeature.Placeholder]: { text: t('markdown.placeholder') },
        [CrepeFeature.TopBar]: {
          buildTopBar: (builder) => {
            // Reuse native icons, commands and link/image interactions.
            const native = new Map(builder.build().flatMap((group) => group.items.map((item) => [item.key, item])))
            const math = native.get('math')
            if (!math) throw new Error('Missing editor toolbar action: math')
            native.set('math', {
              ...math,
              active: (ctx) => {
                const node = ctx.get(schemaCtx).nodes[INLINE_MATH_NODE]
                return Boolean(node && ctx.get(commandsCtx).call(isNodeSelectedCommand.key, node))
              },
              onRun: (ctx) => { ctx.get(commandsCtx).call(TOGGLE_INLINE_MATH_COMMAND) }
            })
            setFormatActions(FORMAT_ACTIONS.map((action) => {
              const item = native.get(action.key)
              if (!item?.onRun) throw new Error(`Missing editor toolbar action: ${action.key}`)
              return { ...action, icon: item.icon, onRun: item.onRun }
            }))
            builder.clear()
            const formats = builder.addGroup('formatting', t('markdown.format'))
            const addNative = (key: string, label: string, group = formats) => {
              const item = native.get(key)
              if (!item) throw new Error(`Missing editor toolbar action: ${key}`)
              group.addItem(key, {
                ...item,
                icon: `<span title="${label}" aria-label="${label}">${item.icon}</span>`,
                onRun: item.onRun
                  ? (ctx) => {
                      markUserEdit()
                      item.onRun?.(ctx)
                    }
                  : undefined,
                active: (ctx) => {
                  const nodeType = key === 'bullet-list' ? bulletListSchema.type(ctx)
                    : key === 'ordered-list' ? orderedListSchema.type(ctx)
                    : key === 'quote' ? blockquoteSchema.type(ctx) : null
                  if (!nodeType) return item.active(ctx)
                  const { $from } = ctx.get(editorViewCtx).state.selection
                  for (let depth = $from.depth; depth > 0; depth--) {
                    if ($from.node(depth).type === nodeType) return true
                  }
                  return false
                }
              })
            }
            addNative('bold', t('markdown.bold'))
            addNative('italic', t('markdown.italic'))
            addNative('strikethrough', t('markdown.strike'))
            HEADING_OPTIONS.filter((option) => option.level !== null && option.level <= 3).forEach((option) => {
              formats.addItem(`h${option.level}`, {
                icon: `<span title="${t(option.labelKey)}" aria-label="${t(option.labelKey)}">H${option.level}</span>`,
                active: (ctx) => {
                  const node = ctx.get(editorViewCtx).state.selection.$from.parent
                  return node.type === headingSchema.type(ctx) && node.attrs.level === option.level
                },
                onRun: (ctx) => {
                  markUserEdit()
                  const node = ctx.get(editorViewCtx).state.selection.$from.parent
                  const active = node.type === headingSchema.type(ctx) && node.attrs.level === option.level
                  ctx.get(commandsCtx).call(setBlockTypeCommand.key, {
                    nodeType: active ? paragraphSchema.type(ctx) : headingSchema.type(ctx),
                    attrs: active ? undefined : { level: option.level }
                  })
                }
              })
            })
            addNative('bullet-list', t('markdown.bullet'))
            addNative('ordered-list', t('markdown.numbered'))
            addNative('link', t('markdown.link'))
            addNative('code', t('markdown.inlineCode'))
            addNative('math', t('markdown.inlineMath'))
            addNative('quote', t('markdown.quote'))
            addNative('table', t('markdown.table'))
            addNative('image', t('markdown.image'), builder.addGroup('media', t('markdown.media')))
          }
        },
        [CrepeFeature.BlockEdit]: {
          buildMenu: (builder) => {
            const native = new Map(builder.build().flatMap((group) => group.items.map((item) => [item.key, item])))
            builder.clear()
            const insert = builder.addGroup('insert', t('markdown.insert'))
            const addNative = (group: typeof insert, key: string, label: string) => {
              const item = native.get(key)
              if (!item) throw new Error(`Missing editor slash action: ${key}`)
              group.addItem(key, {
                ...item,
                label,
                onRun: item.onRun
                  ? (ctx) => {
                      markUserEdit()
                      item.onRun?.(ctx)
                    }
                  : undefined
              })
            }
            for (const [key, label] of [['image', t('markdown.image')], ['math', t('markdown.math')], ['table', t('markdown.table')], ['code', t('markdown.codeBlock')], ['quote', t('markdown.quote')]]) {
              addNative(insert, key, label)
            }
            const structure = builder.addGroup('structure', t('markdown.structure'))
            for (const [key, label] of [['bullet-list', t('markdown.unordered')], ['ordered-list', t('markdown.ordered')], ['divider', t('markdown.divider')]]) {
              addNative(structure, key, label)
            }
            structure.addItem('link', {
              label: t('markdown.link'), icon: EMPTY_ICON,
              onRun: (ctx) => {
                markUserEdit()
                ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
                ctx.get(commandsCtx).call(openLinkEditorCommand.key)
              }
            })
            const headings = builder.addGroup('heading', t('markdown.heading'))
            HEADING_OPTIONS.slice(1).forEach((option) => {
              addNative(headings, `h${option.level}`, `H${option.level}`)
            })
          }
        }
      }
    })
    crepe.editor.use(mathCompatibilityPlugin).use(literalLatexSchema).use(tableColumnInheritancePlugin)
    crepe.editor.use(savedCitationPlugin(handle => {
      setCitationError(false)
      if (session.source.kind !== 'project') { setCitationError(true); return }
      void resolveSavedCitation(session.source, handle).then(setCitation).catch(() => setCitationError(true))
    }))
    crepe.editor.config((ctx) => {
      configureCitationLinks(ctx)
      ctx.update(uploadConfig.key, (config) => ({
        ...config,
        uploader: async (...args) => {
          try {
            return await config.uploader(...args)
          } catch {
            // onUpload has reported the failure. Resolve without nodes so Milkdown
            // removes its upload placeholder instead of leaving a permanent spinner.
            return []
          }
        }
      }))
    })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (!crepeReadyRef.current) return
        if (applyingExternalRef.current || markdown === externallyAppliedMarkdownRef.current) {
          if (markdown === externallyAppliedMarkdownRef.current) {
            externallyAppliedMarkdownRef.current = null
            projectedMarkdownRef.current = markdown
            userEditPendingRef.current = false
          }
          return
        }
        if (!userEditPendingRef.current) {
          projectedMarkdownRef.current = markdown
          return
        }
        commitVisualEdit(markdown)
      })
    })
    crepeRef.current = crepe
    crepeReadyRef.current = false
    const unregisterSave = workspace.registerSaveDelegate(sessionId, {
      prepare: () => commitVisualEdit(crepe.getMarkdown()),
      beforeSave: async () => {
        if (!formatOnSave) return
        const current = workspace.getSnapshot().sessions[sessionId]
        if (!current || current.text === null) return
        const source = current.text
        const sourceChangeVersion = current.changeVersion
        const result = await formatTextOnSave({
          path: current.source.path,
          text: source,
          savedBytes: current.savedBytes
        })
        if (result.status === 'failed') {
          toast({ title: t('formatOnSaveFailed'), tone: 'warning' })
          return
        }
        const latest = workspace.getSnapshot().sessions[sessionId]
        if (
          result.status !== 'formatted'
          || latest?.text !== source
          || latest.changeVersion !== sourceChangeVersion
          || userEditPendingRef.current
        ) return
        replaceExternalText(crepe, result.text)
        workspace.updateText(sessionId, result.text)
      },
      serialize: async () => {
        const current = workspace.getSnapshot().sessions[sessionId]
        return current?.text !== null && current?.text !== undefined
          ? encodeTextForSave(current.text, current.savedBytes)
          : null
      }
    })
    let disposeMathInteraction: (() => void) | undefined
    let disposeReadingPosition: (() => void) | undefined
    let paper: HTMLElement | null = null
    let topBar: HTMLElement | null = null
    let topBarParent: HTMLElement | null = null
    const ready = crepe.create().then(() => {
      if (crepeRef.current !== crepe) return
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const root = view.dom.parentElement
        if (!root) throw new Error('Markdown editor root is unavailable')
        paper = document.createElement('div')
        paper.className = MARKDOWN_PAPER_CLASS
        paper.dataset.testid = 'markdown-paper'
        root.insertBefore(paper, view.dom)
        paper.append(view.dom)
        if (hostRef.current) disposeMathInteraction = installMathBlockInteraction(hostRef.current, view)
      })
      topBar = hostRef.current?.querySelector<HTMLElement>('.milkdown-top-bar') ?? null
      if (!topBar) throw new Error('Markdown formatting toolbar is unavailable')
      topBarParent = topBar.parentElement
      toolbarHost.append(topBar)
      const latestText = latestTextRef.current
      if (latestText !== initialText && crepe.getMarkdown() !== latestText) {
        replaceExternalText(crepe, latestText)
      }
      const markdown = crepe.getMarkdown()
      externallyAppliedMarkdownRef.current = markdown
      projectedMarkdownRef.current = markdown
      userEditPendingRef.current = false
      crepeReadyRef.current = true
      crepe.editor.action((ctx) => {
        const scroller = hostRef.current?.querySelector<HTMLElement>(':scope > .milkdown')
        if (scroller) disposeReadingPosition = preserveMarkdownReadingPosition(scroller, ctx.get(editorViewCtx))
      })
    })

    return () => {
      unregisterSave()
      disposeMathInteraction?.()
      disposeReadingPosition?.()
      imageResolver.dispose()
      crepeRef.current = null
      crepeReadyRef.current = false
      userEditPendingRef.current = false
      projectedMarkdownRef.current = ''
      fragmentReturnRef.current = null
      clearFragmentTarget()
      if (topBar && topBarParent) topBarParent.prepend(topBar)
      void ready.then(() => crepe.destroy()).finally(() => paper?.remove())
    }
  }, [clearFragmentTarget, commitVisualEdit, editorLanguage, formatOnSave, i18n, markUserEdit, replaceExternalText, sessionId, session?.loadState, t, toast, toolbarHost, workspace])

  useEffect(() => {
    const crepe = crepeRef.current
    if (!crepe || !crepeReadyRef.current || session?.text === null || session?.text === undefined || crepe.getMarkdown() === session.text) return
    replaceExternalText(crepe, session.text)
  }, [replaceExternalText, session?.revision, session?.text])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const resetSlashMenu = (event: KeyboardEvent): void => {
      if (event.key !== '/') return
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          host.querySelector<HTMLElement>(SLASH_MENU_SELECTOR)?.scrollTo({ top: 0 })
        })
      })
    }
    host.addEventListener('keydown', resetSlashMenu)
    return () => host.removeEventListener('keydown', resetSlashMenu)
  }, [])

  const captureSelection = (event?: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>): void => {
    const selection = window.getSelection()
    const pointerStart = pointerStartRef.current
    pointerStartRef.current = null
    const text = selection?.toString() ?? ''
    const host = hostRef.current
    const content = host?.querySelector(EDITOR_CONTENT_SELECTOR)
    const crepe = crepeRef.current
    const clearSelection = (): void => {
      if (crepe && crepeReadyRef.current) {
        crepe.editor.action((ctx) => syncCodeEditorSelections(ctx.get(editorViewCtx), null))
      }
      workspace.setSelection(tabId, null)
    }
    const eventPoint = event && 'clientX' in event
      ? { x: event.clientX, y: event.clientY }
      : null
    const target = eventPoint
      ? document.elementFromPoint(eventPoint.x, eventPoint.y)?.closest<HTMLElement>(CODE_EDITOR_SELECTOR) ?? null
      : null
    const pointerSelection = pointerStart && eventPoint
    const nativeSelection = selection
      && !selection.isCollapsed
      && Boolean(text.trim())
      && selection.rangeCount > 0
      && content?.contains(selection.anchorNode)
      && content.contains(selection.focusNode)
    if (
      !selection
      || !host
      || !content
      || (!pointerSelection && !nativeSelection)
    ) {
      clearSelection()
      return
    }
    const range = nativeSelection ? selection.getRangeAt(0) : null
    const rects = Array.from(range?.getClientRects() ?? []).filter(
      (rect) => rect.width > 0 && rect.height > 0
    )
    const last = rects.at(-1)
    if (!last && !pointerSelection) {
      clearSelection()
      return
    }
    const bounds = range && last
      ? range.getBoundingClientRect()
      : {
          left: Math.min(pointerStart?.x ?? 0, eventPoint?.x ?? 0),
          top: Math.min(pointerStart?.y ?? 0, eventPoint?.y ?? 0),
          right: Math.max(pointerStart?.x ?? 0, eventPoint?.x ?? 0),
          bottom: Math.max(pointerStart?.y ?? 0, eventPoint?.y ?? 0),
          width: Math.abs((eventPoint?.x ?? 0) - (pointerStart?.x ?? 0)),
          height: Math.abs((eventPoint?.y ?? 0) - (pointerStart?.y ?? 0))
        }
    const source = session.text ?? ''
    const editorSelection = crepe && crepeReadyRef.current
      ? crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          if (range && (
            !view.dom.contains(range.startContainer)
            || !view.dom.contains(range.endContainer)
          )) return null
          const rangeFrom = range
            ? editorPositionAtDOM(view, range.startContainer, range.startOffset)
            : null
          const rangeTo = range
            ? editorPositionAtDOM(view, range.endContainer, range.endOffset)
            : null
          const anchor = editorPositionAtPoint(view, pointerStart?.host ?? null, pointerStart) ?? (
            selection.anchorNode && rangeFrom !== null
              ? editorPositionAtDOM(view, selection.anchorNode, selection.anchorOffset)
              : rangeFrom
          )
          const focus = editorPositionAtPoint(view, target, eventPoint) ?? (
            selection.focusNode && rangeTo !== null
              ? editorPositionAtDOM(view, selection.focusNode, selection.focusOffset)
              : rangeTo
          )
          if (anchor === null || focus === null) return null
          const hybridFrom = Math.min(anchor, focus)
          const hybridTo = Math.max(anchor, focus)
          if (hybridFrom >= hybridTo) return null
          syncCodeEditorSelections(view, { anchor, focus })
          const doc = view.state.doc
          if (syntaxTreeRef.current?.source !== source) {
            syntaxTreeRef.current = { source, tree: ctx.get(remarkCtx).parse(source) as MarkdownSyntaxNode }
          }
          const rendered = doc.textBetween(0, hybridTo, RENDERED_BLOCK_SEPARATOR, renderedLeafText)
          const renderedFrom = doc.textBetween(0, hybridFrom, RENDERED_BLOCK_SEPARATOR, renderedLeafText).length
          return {
            from: hybridFrom,
            to: hybridTo,
            text: doc.textBetween(hybridFrom, hybridTo, SELECTION_TEXT_SEPARATOR),
            source: markdownSourceRange(source, syntaxTreeRef.current.tree, rendered, renderedFrom, rendered.length)
          }
        })
      : null
    if (!editorSelection && !nativeSelection) {
      clearSelection()
      return
    }
    let start = editorSelection?.source?.start ?? -1
    let end = editorSelection?.source?.end ?? -1
    if (!editorSelection?.source) {
      // Without an exact document mapping, keep only an unambiguous rendered-text match.
      if (range) {
        const prefix = range.cloneRange()
        prefix.selectNodeContents(host)
        prefix.setEnd(range.startContainer, range.startOffset)
        const occurrence = occurrenceCount(prefix.toString(), text)
        const starts = occurrenceStarts(source, text)
        const mapped = starts.length ? null : whitespaceSelection(source, text)
        start = starts[occurrence] ?? mapped?.start ?? -1
        end = mapped?.end ?? start + text.length
      }
    }
    const exact = start >= 0
    const sourceText = editorSelection?.source?.text ?? (exact ? source.slice(start, end) : text)
    refreshFormatState()
    const anchor = {
      document_id: session.documentId,
      document_session_id: session.id,
      revision: session.revision,
      status: exact ? 'exact' : 'stale',
      text: sourceText,
      locator: {
        kind: 'markdown',
        start: exact ? start : -1,
        end: exact ? end : -1,
        ...(editorSelection?.source?.segments ? { segments: editorSelection.source.segments } : {}),
        source_map_version: SOURCE_MAP_VERSION
      }
    } as const
    const replaceable = editorSelection && (
      editorSelection.source
      || editorSelection.text.replace(/\s/gu, '') === text.replace(/\s/gu, '')
    )
    nativeSelectionRef.current = exact && replaceable
      ? {
          changeVersion: session.changeVersion,
          fingerprint: selectionFingerprint(anchor),
          from: editorSelection.from,
          to: editorSelection.to,
          text: editorSelection.text
        }
      : null
    workspace.setSelection(
      tabId,
      anchor,
      selectionViewport(bounds, eventPoint ?? { x: last?.right ?? bounds.right, y: last?.bottom ?? bounds.bottom })
    )
  }

  return (
    <>
      {requestedLanguage !== editorLanguage && <Alert tone="info" title={t('markdown.languagePending')} />}
      {uploadError && <Alert tone="error" title={t('markdown.imageFailed')} description={imageFailureText(uploadError.cause)} />}
      {citationError && <Alert tone="error" title={citationText('savedCitation.error')} />}
      {findOpen && <Dialog open onOpenChange={open => { if (!open) closeFind() }}><DialogPortal><DialogContent>
        <DialogHeader><DialogTitle>{t('markdown.findTitle')}</DialogTitle></DialogHeader>
        <SearchBox
          ref={findInputRef}
          autoFocus
          aria-label={t('markdown.findTitle')}
          data-testid="markdown-find-input"
          placeholder={t('markdown.findPlaceholder')}
          value={findQuery}
          onChange={(event) => {
            setFindQuery(event.target.value)
            setFindResult(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closeFind()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              runFind(event.shiftKey ? -1 : 1)
            }
          }}
        />
        {findResult && <p aria-live="polite" className="m-0 text-sm text-[var(--vds-text-secondary)]">
          {findResult.total
            ? t('markdown.findResult', { current: findResult.current, total: findResult.total })
            : t('markdown.findNoResults')}
        </p>}
        <DialogFooter>
          <Button disabled={!findQuery} variant="secondary" onClick={() => runFind(-1)}>{t('markdown.findPrevious')}</Button>
          <Button disabled={!findQuery} onClick={() => runFind(1)}>{t('markdown.findNext')}</Button>
        </DialogFooter>
      </DialogContent></DialogPortal></Dialog>}
      {citation && <Dialog open onOpenChange={open => { if (!open) setCitation(null) }}><DialogPortal><DialogContent>
        <DialogHeader><DialogTitle>{citation.title}</DialogTitle></DialogHeader>
        <p>{citationText('savedCitation.pages', { pages: citation.pages.map(page => page.page).join(', ') })}</p>
        <blockquote className="m-0 max-h-64 overflow-auto whitespace-pre-wrap text-sm">{citation.quote}</blockquote>
        {citation.state !== 'exact' && <p role="status">{citationText('savedCitation.unavailable')}</p>}
        {citation.can_open_pdf && <Button onClick={() => void workspace.revealCitation(citation, citation.matches[0]).then(() => setCitation(null)).catch(() => setCitationError(true))}>{citationText('savedCitation.open')}</Button>}
      </DialogContent></DialogPortal></Dialog>}

      {fragmentReturnAvailable ? <IconButton
        className="absolute right-[var(--vds-space-5)] top-[var(--vds-space-5)] z-[var(--vds-z-local-control)]"
        data-testid="markdown-return-to-source"
        icon={<Undo2 />}
        label={t('markdown.returnToSource')}
        onClick={returnToFragmentSource}
        size="sm"
        variant="outline"
      /> : null}

      <div
        ref={hostRef}
        className="vds-markdown-crepe [&_.top-bar-item]:!text-[var(--vds-text-primary)]"
        data-shortcut-scope="markdown"
        data-testid="markdown-visual-editor"
        onBeforeInputCapture={markUserEdit}
        onCutCapture={markUserEdit}
        onDropCapture={markUserEdit}
        onPasteCapture={markUserEdit}
        onClickCapture={(event) => {
          const copyButton = copyButtonFromTarget(event.target)
          if (copyButton) {
            event.preventDefault()
            event.stopPropagation()
            const code = codeBlockCopyText(copyButton)
            if (code === null) {
              toast({ title: t('markdown.codeCopyFailed'), tone: 'error' })
              return
            }
            void writeClipboard(code)
              .then(() => toast({ title: t('markdown.codeCopied'), tone: 'success' }))
              .catch(() => toast({ title: t('markdown.codeCopyFailed'), tone: 'error' }))
            return
          }
          const link = event.target instanceof Element
            ? event.target.closest<HTMLElement>(`a[${DOCUMENT_FRAGMENT_ATTRIBUTE}]`)
            : null
          const href = link?.getAttribute(DOCUMENT_FRAGMENT_ATTRIBUTE)
          if (!href || !navigateFragment(href)) return
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDownCapture={(event) => {
          if (copyButtonFromTarget(event.target)) return
          if (event.target instanceof Element && event.target.closest(EDITOR_ACTION_SELECTOR)) markUserEdit()
        }}
        onMouseDownCapture={(event) => {
          const content = hostRef.current?.querySelector(EDITOR_CONTENT_SELECTOR)
          if (!(event.target instanceof Node) || !content?.contains(event.target)) {
            pointerStartRef.current = null
            return
          }
          const host = event.target instanceof Element
            ? event.target.closest<HTMLElement>(CODE_EDITOR_SELECTOR)
            : null
          pointerStartRef.current = { host, x: event.clientX, y: event.clientY }
        }}
        onMouseMoveCapture={(event) => {
          const pointerStart = pointerStartRef.current
          const crepe = crepeRef.current
          if (!pointerStart || event.buttons !== 1 || !crepe || !crepeReadyRef.current) return
          const host = event.target instanceof Element
            ? event.target.closest<HTMLElement>(CODE_EDITOR_SELECTOR)
            : null
          const point = { x: event.clientX, y: event.clientY }
          crepe.editor.action((ctx) => {
            syncCodeEditorPointerSelection(ctx.get(editorViewCtx), pointerStart, host, point)
          })
        }}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        onKeyDownCapture={(event) => {
          const shortcut = resolveMarkdownShortcut(event.nativeEvent)
          if (!shortcut && !suppressMarkdownDefaultShortcut(event.nativeEvent)) return
          event.preventDefault()
          event.stopPropagation()
          if (shortcut) runMarkdownShortcut(shortcut.id)
        }}
      />
    </>
  )
}

export function MarkdownDocument({
  formatOnSave = false,
  sessionId,
  tabId,
  toolbarActions,
  viewKind
}: {
  formatOnSave?: boolean
  sessionId: string
  tabId: string
  toolbarActions?: ReactNode
  viewKind: DocumentViewKind
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const editorRuntimeRevision = useApp().state.editorRuntimeRevision
  const session = useDocumentWorkspace().sessions[sessionId]
  const workspace = useWorkspaceController()
  const [editorToolbarHost, setEditorToolbarHost] = useState<HTMLDivElement | null>(null)
  const visualDisabled = Boolean(session?.lightweightText)

  useEffect(() => {
    if (visualDisabled && viewKind === 'edit') workspace.setTabView(tabId, 'preview')
  }, [tabId, viewKind, visualDisabled, workspace])

  if (!session || session.loadState === 'loading') {
    return <div className="vds-viewer-empty">{t('markdown.opening')}</div>
  }
  if (session.loadState === 'error' || session.text === null) {
    return <div className="vds-viewer-empty">{t('markdown.unreadable')}</div>
  }

  return (
    <section className="vds-markdown-workbench grid size-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--vds-bg-gray-default)]">
      <MarkdownHeader
        sessionId={sessionId}
        tabId={tabId}
        viewKind={viewKind}
        editorActionsRef={setEditorToolbarHost}
        toolbarActions={toolbarActions}
        visualDisabled={visualDisabled}
      />
      {viewKind === 'preview' || visualDisabled
        ? (
            <div className="vds-markdown-source min-h-0 min-w-0 overflow-hidden" data-testid="markdown-source-editor">
              <MonacoDocument key={`${tabId}:${editorRuntimeRevision}`} formatOnSave={formatOnSave} sessionId={sessionId} tabId={tabId} viewKind={viewKind} toolbarHost={editorToolbarHost} />
            </div>
          )
        : (
            <div className="vds-markdown-visual">
              <MarkdownVisualEditor
                formatOnSave={formatOnSave}
                sessionId={sessionId}
                tabId={tabId}
                toolbarHost={editorToolbarHost}
              />
            </div>
          )}
    </section>
  )
}
