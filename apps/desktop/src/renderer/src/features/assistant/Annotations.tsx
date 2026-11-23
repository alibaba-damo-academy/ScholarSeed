import { assistantFailureDetail } from './failure'
import { sessionFileRawUrl } from '../../api'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, MessageCirclePlus, Plus } from 'lucide-react'

import type { ResourceLocationRef } from '../../contracts/resources'
import { CITATION_URL_PREFIX, citationReferenceUrl, isCitationUrl } from '../../contracts/citations'
import { citationSourceGroupKeys } from '../../components/business/grouping'
import type { AnswerCoverage, AnswerSource } from '../../model'
import { activeThread, useApp } from '../../store'
import { Markdown } from '../../components/primitive/Markdown'
import { writeClipboard } from '../../components/primitive/clipboard'
import { mappedSourceBoundary } from '../../components/markdown/source'
import { Button, Divider, FloatingToolbar, Portal, useToast } from '../../components/ui'
import { expandedResourceAncestors } from '../../contracts/resources'
import { citationSources, fetchResourceDirectoryTree, saveAnswerSelectionToResource } from './api'
import { ANSWER_ANNOTATION_LOCATION, sha256Text } from './anchors'
import { ResourceSaveDialog } from './Save'
import {
  CitationGroup,
  CitationLink,
  CitationSources,
  WebCitationLink,
  useAnswerCitationSources,
} from './Citations'
import { AnnotationBadgeNote, annotationDisplay } from './Notes'
import { sentAnswerAnnotationIds } from './state'
import { defaultExcerptName } from './names'
import {
  selectionToolbarPosition,
  shouldClosePointerToolbar,
  type SelectionToolbarPosition,
} from './selection-toolbar'
import { ProjectSourceLink, SessionFileLink } from './Links'
import { answerProjectSource, projectSourceName, sharedTaskSources } from './sources'

import { answerIdentifier, ITEM_ID_PREFIX } from './bindings'
// 设计稿: 注释标识悬浮在被注释文本结束处的上方(蓝色气泡+序号);
// 零宽行内锚点不参与文字排版, 浮层相对锚点抬升到当前行上方。
const INLINE_MARKER_ANCHOR_CLASS = 'relative inline-block h-0 w-0'
const INLINE_MARKER_FLOAT_CLASS =
  'absolute bottom-full left-0 z-[var(--vds-z-local-top)] mb-[var(--vds-space-3)] -translate-x-1/2'
const ANSWER_ANNOTATION_FOCUS_DURATION_MS = 2400
const CONVERSATION_STREAM_SELECTOR = '.conversation-stream'
const SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX = 16
const ANNOTATION_ERROR_MESSAGES = {
  answer_revision_conflict: 'remaining.revisionConflict',
  answer_quote_mismatch: 'remaining.quoteMismatch',
  assistant_session_unavailable: 'remaining.sessionUnavailable',
} as const
const ANNOTATION_SAVE_FALLBACK_MESSAGE = 'remaining.annotationFailed'
const ANSWER_ANNOTATION_SAVE_TOAST_ID = 'answer-annotation-save-failed'
// 选区菜单项共用一套样式：默认不上底色，仅 hover 时高亮，避免某一项看起来像已选中。
const SELECTION_ACTION_CLASS =
  'shrink-0 whitespace-nowrap !gap-[calc(var(--vds-space-1)+var(--vds-space-half))] rounded-[var(--vds-radius-3)] !border-0 px-[var(--vds-space-3)] !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !text-[var(--vds-text-primary)] !shadow-none hover:!bg-[var(--vds-surface-hover)]'

interface SelectionDraft {
  clientAnnotationId: string
  startUtf16: number
  endUtf16: number
  selectedMarkdown: string
  previewText: string
  clipboardText: string
  left: number
  selectionTop: number
  selectionBottom: number
}

function descendantLeaf(node: Node, root: HTMLElement, edge: 'first' | 'last'): HTMLElement | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const element = node as HTMLElement
  if (element.matches('[data-md-source-start]')) return root.contains(element) ? element : null
  const leaves = element.querySelectorAll<HTMLElement>('[data-md-source-start]')
  const leaf = edge === 'first' ? leaves[0] : leaves[leaves.length - 1]
  return leaf && root.contains(leaf) ? leaf : null
}

function leafBoundary(leaf: HTMLElement, edge: 'first' | 'last'): number | null {
  const value = Number(edge === 'first' ? leaf.dataset.mdSourceStart : leaf.dataset.mdSourceEnd)
  return Number.isInteger(value) ? value : null
}

function ownLeaf(node: Node, root: HTMLElement): HTMLElement | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  const leaf = element?.closest<HTMLElement>('[data-md-source-start]')
  return leaf && root.contains(leaf) ? leaf : null
}

// 选区边界落在无 source 映射的容器(p/h/strong 等)上时, offset 是子节点索引;
// closest 只向祖先方向找, 映射叶子其实在子树里, 需沿 edge 方向下钻取最近叶子。
function selectionLeaf(
  node: Node,
  offset: number,
  root: HTMLElement,
  edge: 'start' | 'end'
): HTMLElement | null {
  const own = ownLeaf(node, root)
  if (own || node.nodeType === Node.TEXT_NODE) return own
  const children = Array.from((node as HTMLElement).childNodes)
  if (!children.length) return null
  if (edge === 'start') {
    if (offset >= children.length) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const leaf = descendantLeaf(children[index], root, 'last')
        if (leaf) return leaf
      }
      return null
    }
    for (let index = Math.max(0, offset); index < children.length; index += 1) {
      const leaf = descendantLeaf(children[index], root, 'first')
      if (leaf) return leaf
    }
    return null
  }
  if (offset <= 0) {
    for (let index = 0; index < children.length; index += 1) {
      const leaf = descendantLeaf(children[index], root, 'first')
      if (leaf) return leaf
    }
    return null
  }
  for (let index = Math.min(offset, children.length) - 1; index >= 0; index -= 1) {
    const leaf = descendantLeaf(children[index], root, 'last')
    if (leaf) return leaf
  }
  return null
}

function sourceBoundary(
  node: Node,
  offset: number,
  root: HTMLElement,
  edge: 'start' | 'end'
): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const leaf = ownLeaf(node, root)
    if (!leaf) return null
    return mappedSourceBoundary(leaf, offset)
  }
  const element = node as HTMLElement
  const own = ownLeaf(node, root)
  if (own === element) {
    const prefix = Array.from(element.childNodes)
      .slice(0, offset)
      .map((child) => child.textContent ?? '')
      .join('')
    return mappedSourceBoundary(element, prefix.length)
  }
  // 其余情况(容器无映射, 或祖先带映射但 offset 是相对当前容器的子索引无法换算)
  // 统一沿 edge 方向下钻子树取最近叶子边界。
  const children = Array.from(element.childNodes)
  if (edge === 'start') {
    if (offset < children.length) {
      for (let index = Math.max(0, offset); index < children.length; index += 1) {
        const leaf = descendantLeaf(children[index], root, 'first')
        if (leaf) return leafBoundary(leaf, 'first')
      }
      return null
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const leaf = descendantLeaf(children[index], root, 'last')
      if (leaf) return leafBoundary(leaf, 'last')
    }
    return null
  }
  if (offset > 0) {
    for (let index = Math.min(offset, children.length) - 1; index >= 0; index -= 1) {
      const leaf = descendantLeaf(children[index], root, 'last')
      if (leaf) return leafBoundary(leaf, 'last')
    }
    return null
  }
  for (let index = 0; index < children.length; index += 1) {
    const leaf = descendantLeaf(children[index], root, 'first')
    if (leaf) return leafBoundary(leaf, 'first')
  }
  return null
}

function occurrenceStartsIn(source: string, selected: string): number[] {
  const starts: number[] = []
  if (!selected) return starts
  let offset = 0
  while (offset <= source.length - selected.length) {
    const found = source.indexOf(selected, offset)
    if (found < 0) break
    starts.push(found)
    offset = found + Math.max(1, selected.length)
  }
  return starts
}

// For blocks where per-character source mapping is absent (code fences, table
// cells, mermaid/formula blocks), locate previewText inside the raw markdown
// of the enclosing block by literal indexOf, disambiguated by DOM occurrence
// count. Returns null when raw source and rendered text diverge too much to
// map (e.g. inline formatting expansion, image alts, cross-block selections).
function fallbackSelectionOffsets(
  range: Range,
  root: HTMLElement,
  sourceText: string,
  previewText: string
): { startUtf16: number; endUtf16: number } | null {
  if (!previewText) return null
  const startLeaf = selectionLeaf(range.startContainer, range.startOffset, root, 'start')
  const endLeaf = selectionLeaf(range.endContainer, range.endOffset, root, 'end')
  if (!startLeaf || !endLeaf) return null
  const s1 = Number(startLeaf.dataset.mdSourceStart)
  const e1 = Number(startLeaf.dataset.mdSourceEnd)
  const s2 = Number(endLeaf.dataset.mdSourceStart)
  const e2 = Number(endLeaf.dataset.mdSourceEnd)
  if (![s1, e1, s2, e2].every(Number.isInteger)) return null
  const windowStart = Math.min(s1, s2)
  const windowEnd = Math.max(e1, e2)
  if (windowStart < 0 || windowEnd > sourceText.length || windowStart >= windowEnd) return null
  const window = sourceText.slice(windowStart, windowEnd)
  const starts = occurrenceStartsIn(window, previewText)
  if (!starts.length) return null
  const preRange = range.cloneRange()
  preRange.selectNodeContents(root)
  preRange.setEnd(range.startContainer, range.startOffset)
  const occurrence = occurrenceStartsIn(preRange.toString(), previewText).length
  const chosen = starts[occurrence] ?? starts[starts.length - 1]
  if (chosen === undefined) return null
  return { startUtf16: windowStart + chosen, endUtf16: windowStart + chosen + previewText.length }
}

export function AnnotatedAnswer({
  pending = false,
  citationEnabled,
  text,
  eventSeq,
  evidence,
  selectionEnabled,
  turnId,
  messageId,
  markdownClassName,
  answerSources,
  answerCoverage,
  citationPending = false,
  showSources = true,
  loadRemoteImage,
}: {
  citationEnabled: boolean
  text: string
  eventSeq?: number
  evidence?: Parameters<typeof Markdown>[0]['evidence']
  selectionEnabled: boolean
  turnId?: string
  /**
   * Stable identifier for the turn message being annotated. When provided,
   * takes precedence over `eventSeq` and lets the component annotate any kind
   * of assistant turn output (agent answers, reasoning/thinking, tool
   * results). Format: `item:{vendor_item_id}` for the new identity scheme, or
   * `answer:{event_seq}` for legacy agent-only calls.
   */
  messageId?: string | null
  /**
   * Class name applied to the inner Markdown renderer. Defaults to the agent
   * answer style; callers rendering thinking or tool bodies pass their own.
   */
  markdownClassName?: string
  answerSources?: AnswerSource[]
  answerCoverage?: AnswerCoverage
  citationPending?: boolean
  pending?: boolean
  showSources?: boolean
  loadRemoteImage?: Parameters<typeof Markdown>[0]['loadRemoteImage']
}): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('components')
  const { t: a } = useTranslation('assistant')
  const { toast } = useToast()
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(null)
  const bindToolbar = React.useCallback((element: HTMLDivElement | null) => {
    toolbarRef.current = element
    setToolbarElement(element)
  }, [])
  const [toolbarLeft, setToolbarLeft] = useState(0)
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null)
  const annotationSavingRef = useRef(false)
  const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SelectionDraft | null>(null)
  const [toolbarPosition, setToolbarPosition] = useState<SelectionToolbarPosition>({
    placement: 'below',
    top: 0,
  })
  const selectionIdentity = draft?.clientAnnotationId ?? null
  const selectionTop = draft?.selectionTop ?? 0
  const selectionBottom = draft?.selectionBottom ?? 0
  const selectionLeft = draft?.left ?? 0
  useLayoutEffect(() => {
    const root = rootRef.current
    const toolbar = toolbarElement
    if (!selectionIdentity || !root || !toolbar) return
    const stream = root.closest<HTMLElement>(CONVERSATION_STREAM_SELECTOR)
    const updatePosition = (): void => {
      const rootBounds = root.getBoundingClientRect()
      const streamBounds = stream?.getBoundingClientRect()
      const visibleTop = Math.max(0, streamBounds?.top ?? 0) + SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX
      const visibleBottom =
        Math.min(window.innerHeight, streamBounds?.bottom ?? window.innerHeight) -
        SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX
      const toolbarHeight = toolbar.getBoundingClientRect().height
      const toolbarHalfWidth = toolbar.getBoundingClientRect().width / 2
      const selectionCenter = rootBounds.left + selectionLeft
      setToolbarLeft(
        Math.max(
          SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX + toolbarHalfWidth,
          Math.min(
            selectionCenter,
            window.innerWidth - SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX - toolbarHalfWidth
          )
        )
      )
      setToolbarPosition((current) => {
        const next = selectionToolbarPosition({
          currentPlacement: current.placement,
          devicePixelRatio: window.devicePixelRatio,
          rootTop: 0,
          selectionBottom: rootBounds.top + selectionBottom,
          selectionTop: rootBounds.top + selectionTop,
          toolbarHeight,
          visibleBottom,
          visibleTop,
        })
        return current.top === next.top && current.placement === next.placement ? current : next
      })
    }
    updatePosition()
    const observer = new ResizeObserver(updatePosition)
    observer.observe(toolbar)
    observer.observe(root)
    if (stream) observer.observe(stream)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [selectionBottom, selectionIdentity, selectionLeft, selectionTop, toolbarElement])
  const draftRef = useRef<SelectionDraft | null>(null)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const [saving, setSaving] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sourceCount, setSourceCount] = useState<number | null>(null)
  const [saveLocation, setSaveLocation] = useState<ResourceLocationRef>({ parent: '', name: '' })
  const [resourceTree, setResourceTree] = useState(state.resource.tree)
  const [targetProjectId, setTargetProjectId] = useState('')
  const thread = activeThread(state)
  const sessionProject =
    state.projects.find((project) => project.path === thread.projectPath) ?? null
  const observedSources = useMemo(
    () => (sessionProject ? sharedTaskSources(thread.conversation, sessionProject.id) : []),
    [thread.conversation, sessionProject]
  )
  const targetProject = state.projects.find((project) => project.id === targetProjectId) ?? null
  const answerId = answerIdentifier(messageId, eventSeq)
  const resolvedCitationSources = useAnswerCitationSources(
    thread.sessionId,
    answerId,
    text,
    citationEnabled &&
      !pending &&
      (text.includes(CITATION_URL_PREFIX) ||
        Boolean(answerSources?.some((source) => source.kind === 'receipt')))
  )
  const citationGroupKeys = useMemo(
    () => citationSourceGroupKeys(resolvedCitationSources, answerSources),
    [resolvedCitationSources, answerSources]
  )
  const originalQuestion = useMemo(() => {
    const item = thread.conversation.find(
      (candidate) => candidate.kind === 'user' && candidate.turnId === turnId
    )
    return item?.kind === 'user' ? item.text : ''
  }, [thread.conversation, turnId])
  const sentAnnotationIds = useMemo(
    () =>
      sentAnswerAnnotationIds(
        thread.conversation,
        state.aiPanel.refs,
        state.aiPanel.submittedRefIds
      ),
    [thread.conversation, state.aiPanel.refs, state.aiPanel.submittedRefIds]
  )
  const annotations = useMemo(() => {
    if (!answerId) return []
    const itemId = messageId?.startsWith(ITEM_ID_PREFIX)
      ? messageId.slice(ITEM_ID_PREFIX.length)
      : null
    return state.aiPanel.annotations.filter(
      (annotation) =>
        annotation.answer_id === answerId ||
        // 身份漂移容忍: 历史回放后 vendor item id 或旧 answer 方案可能与
        // 注释保存时的 id 不一致, 用来源身份回退匹配, 保证内联标识仍渲染。
        (itemId !== null && annotation.source_item_id === itemId) ||
        (eventSeq !== undefined &&
          annotation.source_product_seq === eventSeq &&
          (!turnId || annotation.source_turn_id === turnId))
    )
  }, [answerId, eventSeq, messageId, state.aiPanel.annotations, turnId])
  const annotationFocus = state.aiPanel.answerAnnotationFocus
  const focusedAnnotation = useMemo(() => {
    if (
      !answerId ||
      annotationFocus?.answerId !== answerId ||
      annotationFocus.status !== ANSWER_ANNOTATION_LOCATION.AVAILABLE
    )
      return null
    return (
      state.aiPanel.annotations.find(
        (annotation) => annotation.annotation_id === annotationFocus.annotationId
      ) ?? null
    )
  }, [annotationFocus, answerId, state.aiPanel.annotations])

  const captureSelection = (): void => {
    const root = rootRef.current
    const selection = window.getSelection()
    if (
      !selectionEnabled ||
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount !== 1 ||
      !answerId
    )
      return
    const range = selection.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    const clipboardText = selection.toString()
    const previewText = clipboardText.trim()
    if (!previewText) return
    let start = sourceBoundary(range.startContainer, range.startOffset, root, 'start')
    let end = sourceBoundary(range.endContainer, range.endOffset, root, 'end')
    if (start === null || end === null || end <= start) {
      const fallback = fallbackSelectionOffsets(range, root, text, previewText)
      if (!fallback) return
      start = fallback.startUtf16
      end = fallback.endUtf16
    }
    if (start === null || end === null || end <= start) return
    const rootBounds = root.getBoundingClientRect()
    const selectionBounds = range.getBoundingClientRect()
    setSaveError(null)
    setToolbarPosition({
      placement: 'below',
      top: selectionBounds.bottom - rootBounds.top,
    })
    setDraft({
      clientAnnotationId: crypto.randomUUID(),
      startUtf16: start,
      endUtf16: end,
      selectedMarkdown: text.slice(start, end),
      previewText,
      clipboardText,
      left: selectionBounds.left + selectionBounds.width / 2 - rootBounds.left,
      selectionTop: selectionBounds.top - rootBounds.top,
      selectionBottom: selectionBounds.bottom - rootBounds.top,
    })
  }

  const copySelection = async (): Promise<void> => {
    if (!draft) return
    try {
      await writeClipboard(draft.clipboardText)
      setDraft((current) => (current === draft ? null : current))
      toast({ title: a('remaining.textCopied'), tone: 'success' })
    } catch {
      toast({ title: a('remaining.textCopyFailed'), tone: 'error' })
    }
  }

  const openSaveDialog = (): void => {
    if (!draft) return
    const project = sessionProject ?? state.projects[0]
    if (!project) return
    setTargetProjectId(project.id)
    setSaveLocation({ parent: '', name: defaultExcerptName(draft.previewText, a) })
    setResourceTree(state.homeSelectedProjectId === project.id ? state.resource.tree : [])
    setSaveError(null)
    setSaveDialogOpen(true)
    setSourceCount(null)
    if (answerId && thread.sessionId) {
      void sha256Text(text)
        .then((revision) =>
          citationSources(thread.sessionId!, answerId, revision, {
            start: draft.startUtf16,
            end: draft.endUtf16,
          })
        )
        .then((result) => setSourceCount(result.sources.length))
        .catch(() => setSourceCount(null))
    }
    void fetchResourceDirectoryTree(project.id).then(setResourceTree)
  }

  const selectTargetProject = (projectId: string): void => {
    setTargetProjectId(projectId)
    setSaveLocation((current) => ({ ...current, parent: '' }))
    setResourceTree([])
    void fetchResourceDirectoryTree(projectId).then(setResourceTree)
  }

  const closeDraft = (): void => {
    window.getSelection()?.removeAllRanges()
    setDraft(null)
  }

  const showAnnotationError = (error?: string): void => {
    const messageKey = Object.prototype.hasOwnProperty.call(ANNOTATION_ERROR_MESSAGES, error ?? '')
      ? ANNOTATION_ERROR_MESSAGES[error as keyof typeof ANNOTATION_ERROR_MESSAGES]
      : ANNOTATION_SAVE_FALLBACK_MESSAGE
    toast({
      id: ANSWER_ANNOTATION_SAVE_TOAST_ID,
      tone: 'error',
      title: a(messageKey),
    })
  }

  const addAnnotation = async (): Promise<void> => {
    if (!draft || !answerId || annotationSavingRef.current) return
    annotationSavingRef.current = true
    setSaving(true)
    try {
      const [answerRevision, selectedTextHash] = await Promise.all([
        sha256Text(text),
        sha256Text(draft.selectedMarkdown),
      ])
      const result = await act.createAnswerAnnotation(answerId, {
        client_annotation_id: draft.clientAnnotationId,
        answer_revision: answerRevision,
        start_utf16: draft.startUtf16,
        end_utf16: draft.endUtf16,
        selected_text_hash: selectedTextHash,
        preview_text: draft.previewText,
        comment: '',
        enqueue: true,
      })
      if (!result.ok || !result.annotation) {
        showAnnotationError(result.error)
        return
      }
      const annotationId = result.annotation.annotation_id
      setDraft((current) =>
        current?.clientAnnotationId === draft.clientAnnotationId ? null : current
      )
      setEditingAnnotationId(annotationId)
      window.getSelection()?.removeAllRanges()
    } catch {
      showAnnotationError()
    } finally {
      annotationSavingRef.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!draft || saveDialogOpen) return undefined
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (
        !shouldClosePointerToolbar(
          event.button,
          toolbarRef.current?.contains(target) ?? false,
          rootRef.current?.contains(target) ?? false
        )
      )
        return
      closeDraft()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
  }, [draft, saveDialogOpen])

  // onMouseUp above covers the common mouse case. This effect fills the gap
  // for Shift+Arrow / Home / End, touch drag ending outside the root, and
  // trackpad flows that release outside our subtree. We only trigger on
  // pointerup/keyup (drag/keyboard settle), not on every selectionchange, to
  // avoid resetting an active toolbar mode (e.g. comment) mid-interaction.
  const captureSelectionRef = useRef(captureSelection)
  useEffect(() => {
    captureSelectionRef.current = captureSelection
  })
  useEffect(() => {
    if (!selectionEnabled || !answerId) return undefined
    let scheduled = 0
    const react = (): void => {
      if (scheduled) return
      scheduled = window.requestAnimationFrame(() => {
        scheduled = 0
        const root = rootRef.current
        const selection = window.getSelection()
        if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return
        const range = selection.getRangeAt(0)
        if (!root.contains(range.commonAncestorContainer)) return
        const previewText = selection.toString().trim()
        if (!previewText) return
        if (draftRef.current && draftRef.current.previewText === previewText) return
        captureSelectionRef.current()
      })
    }
    document.addEventListener('pointerup', react)
    document.addEventListener('keyup', react)
    return () => {
      if (scheduled) window.cancelAnimationFrame(scheduled)
      document.removeEventListener('pointerup', react)
      document.removeEventListener('keyup', react)
    }
  }, [selectionEnabled, answerId])

  const displayedAnnotations =
    focusedAnnotation &&
    !annotations.some((annotation) => annotation.annotation_id === focusedAnnotation.annotation_id)
      ? [...annotations, focusedAnnotation]
      : annotations
  const answerAnnotations = displayedAnnotations.map((annotation) => ({
    id: annotation.annotation_id,
    start_utf16: annotation.start_utf16,
    end_utf16: annotation.end_utf16,
    focused: annotation.annotation_id === focusedAnnotation?.annotation_id,
    highlighted: annotation.annotation_id === highlightedAnnotationId,
  }))

  useEffect(() => {
    if (!focusedAnnotation || !annotationFocus || !rootRef.current) return undefined
    const target = Array.from(
      rootRef.current.querySelectorAll<HTMLElement>('[data-scholarseed-answer-annotation-id]')
    ).find(
      (element) => element.dataset.scholarseedAnswerAnnotationId === focusedAnnotation.annotation_id
    )
    if (!target) return undefined
    const stream = target.closest<HTMLElement>(CONVERSATION_STREAM_SELECTOR)
    if (stream) {
      const streamBounds = stream.getBoundingClientRect()
      const targetBounds = target.getBoundingClientRect()
      const targetCenter = targetBounds.top + targetBounds.height / 2
      const streamCenter = streamBounds.top + streamBounds.height / 2
      stream.scrollTo({
        top: stream.scrollTop + targetCenter - streamCenter,
        behavior: 'smooth',
      })
    } else {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    }
    const timer = window.setTimeout(() => {
      act.clearAnswerAnnotationFocus(annotationFocus.sequence)
    }, ANSWER_ANNOTATION_FOCUS_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [act, annotationFocus, focusedAnnotation])

  const saveSelectionResource = async (): Promise<void> => {
    if (!draft || !answerId || !thread.sessionId || !targetProject) return
    setSaving(true)
    setSaveError(null)
    const selectedMarkdown = text.slice(draft.startUtf16, draft.endUtf16)
    const [answerRevision, selectedTextHash] = await Promise.all([
      sha256Text(text),
      sha256Text(selectedMarkdown),
    ])
    const result = await saveAnswerSelectionToResource(
      {
        sessionId: thread.sessionId,
        projectId: targetProject.id,
        answerId,
        answerRevision,
        startUtf16: draft.startUtf16,
        endUtf16: draft.endUtf16,
        selectedTextHash,
        selectedMarkdown,
        question: originalQuestion,
        location: saveLocation,
      },
      a
    )
    setSaving(false)
    if (!result.ok || !result.node) {
      setSaveError(assistantFailureDetail(result) ?? '')
      return
    }
    setSaveDialogOpen(false)
    if (state.homeSelectedProjectId === targetProject.id) {
      const expanded = expandedResourceAncestors(
        resourceTree,
        saveLocation.parent,
        state.resource.expanded
      )
      if (saveLocation.parent) expanded[saveLocation.parent] = true
      await act.reloadResourceTree(expanded)
      act.selectResourceFile(result.node.path)
    }
    act.noticeResource(
      'ok',
      { key: 'feedback.savedResource', name: result.node.name },
      {
        path: result.node.path,
        projectId: targetProject.id,
      }
    )
    window.getSelection()?.removeAllRanges()
    setDraft(null)
  }

  return (
    <div
      className="answer-annotation-root"
      data-answer-id={answerId ?? undefined}
      ref={rootRef}
      onMouseUp={captureSelection}
    >
      <Markdown
        math
        loadRemoteImage={loadRemoteImage}
        pending={pending}
        resolveImage={
          thread.sessionId ? (path) => sessionFileRawUrl(thread.sessionId!, path) : undefined
        }
        answerAnnotations={answerAnnotations}
        className={markdownClassName ?? 'md-agent'}
        evidence={evidence}
        renderSourceLink={(href, children) => {
          const project = state.projects.find((candidate) => candidate.path === thread.projectPath)
          const source = project && answerProjectSource(href, project, observedSources)
          if (!source || !project) return undefined
          const name = projectSourceName(source, observedSources)
          if (name)
            return (
              <ProjectSourceLink
                name={name}
                onOpen={() => {
                  if (source.kind === 'resource') act.openResourceFile(source.path, project.id)
                  else void act.openLiteratureItem(source.id, project.id)
                }}
              />
            )
          return (
            <Button
              unstyled
              className="inline text-[var(--vds-link)] underline hover:text-[var(--vds-link-hover)]"
              data-testid="project-source-link"
              onClick={() => {
                if (source.kind === 'resource') act.openResourceFile(source.path, project.id)
                else void act.openLiteratureItem(source.id, project.id)
              }}
            >
              {children}
            </Button>
          )
        }}
        renderSessionFileLink={
          thread.sessionId
            ? (path, children) => (
                <SessionFileLink
                  sessionId={thread.sessionId!}
                  path={path}
                  onOpen={() =>
                    act.openFilePreview({
                      sessionId: thread.sessionId!,
                      path,
                      resolveChatLink: true,
                    })
                  }
                >
                  {children}
                </SessionFileLink>
              )
            : undefined
        }
        citationUrls={answerSources?.flatMap((source) => source.citation_urls)}
        citationReferences={answerSources?.flatMap((source) =>
          source.kind === 'searched' && source.citation_urls[0]
            ? (source.reference_labels ?? []).map((label) => ({
                label,
                href: source.citation_urls[0],
              }))
            : []
        )}
        citationPending={citationPending}
        citationGroupKeys={citationGroupKeys}
        renderCitationGroup={
          answerId && thread.sessionId && citationEnabled
            ? (entries) => (
                <CitationGroup
                  key={`${thread.sessionId}:${answerId}:${entries[0].start}`}
                  sessionId={thread.sessionId!}
                  answerId={answerId}
                  text={text}
                  entries={entries}
                  sources={resolvedCitationSources}
                  answerSources={answerSources}
                />
              )
            : undefined
        }
        citationOccurrences={answerSources?.flatMap((source) =>
          source.kind === 'searched'
            ? (source.occurrences ?? []).map((occurrence) => ({
                href: source.citation_urls[0] ?? source.url,
                end_utf16: occurrence.end_utf16,
              }))
            : []
        )}
        renderCitation={
          answerId && thread.sessionId && citationEnabled
            ? (range, children, href) => {
                const source = answerSources?.find((candidate) =>
                  candidate.citation_urls.includes(href)
                )
                if (source?.kind === 'searched') {
                  return (
                    <WebCitationLink
                      key={`${thread.sessionId}:${answerId}:${range.start}`}
                      source={source}
                    />
                  )
                }
                const identity = resolvedCitationSources.find((candidate) =>
                  source?.kind === 'receipt'
                    ? candidate.handle === source.handle
                    : citationReferenceUrl(candidate.handle) === href
                )
                if (source?.kind === 'receipt') {
                  return (
                    <CitationLink
                      key={`${thread.sessionId}:${answerId}:${range.start}`}
                      sessionId={thread.sessionId!}
                      answerId={answerId}
                      text={text}
                      range={range}
                      displayNumber={source.number}
                      identity={identity}
                    >
                      {children}
                    </CitationLink>
                  )
                }
                return isCitationUrl(href) ? (
                  <CitationLink
                    key={`${thread.sessionId}:${answerId}:${range.start}`}
                    sessionId={thread.sessionId!}
                    answerId={answerId}
                    text={text}
                    range={range}
                    identity={identity}
                  >
                    {children}
                  </CitationLink>
                ) : undefined
              }
            : undefined
        }
        renderAnswerAnnotationMarker={(marker) => {
          const annotation = displayedAnnotations.find((item) => item.annotation_id === marker.id)
          if (!annotation || sentAnnotationIds.has(annotation.annotation_id)) return null
          const number =
            displayedAnnotations.findIndex((item) => item.annotation_id === marker.id) + 1
          const noteText = annotation.comment || annotation.preview_text
          return (
            <span className={INLINE_MARKER_ANCHOR_CLASS} key={marker.id}>
              <span className={INLINE_MARKER_FLOAT_CLASS}>
                <AnnotationBadgeNote
                  annotation={annotationDisplay(annotation)}
                  ariaLabel={a('remaining.annotationLabel', { number, comment: noteText })}
                  noteText={noteText}
                  number={number}
                  open={editingAnnotationId === annotation.annotation_id ? true : undefined}
                  onOpenChange={(open) => {
                    if (!open && editingAnnotationId === annotation.annotation_id) {
                      setEditingAnnotationId(null)
                    }
                    setHighlightedAnnotationId((current) =>
                      open
                        ? annotation.annotation_id
                        : current === annotation.annotation_id
                          ? null
                          : current
                    )
                  }}
                  onRemove={(annotationId) => act.deleteAnswerAnnotation(annotationId)}
                  onSave={(annotationId, nextComment) =>
                    act.updateAnswerAnnotation(annotationId, nextComment)
                  }
                />
              </span>
            </span>
          )
        }}
        sourceMapped
        text={text}
      />
      {showSources && answerId && thread.sessionId && (citationEnabled || answerCoverage) && (
        <CitationSources
          sessionId={thread.sessionId}
          answerId={answerId}
          text={text}
          answerSources={answerSources}
          coverage={answerCoverage}
          resolveEnabled={citationEnabled}
        />
      )}
      {draft ? (
        <Portal hosted>
          <div
            className={`answer-selection-anchor !z-[var(--vds-z-inline-flyout)] !fixed flex w-max flex-col items-center -translate-x-1/2 ${
              toolbarPosition.placement === 'above' ? '-translate-y-full pb-2' : 'pt-2'
            }`}
            ref={bindToolbar}
            style={{ left: toolbarLeft, top: toolbarPosition.top }}
            onMouseUp={(event) => event.stopPropagation()}
          >
            <FloatingToolbar
              actions={
                <div className="flex w-max flex-nowrap items-center gap-[var(--vds-space-half)]">
                  <Button
                    className={SELECTION_ACTION_CLASS}
                    icon={<MessageCirclePlus size={14} />}
                    disabled={saving}
                    onClick={() => void addAnnotation()}
                    size="sm"
                    variant="ghost"
                  >
                    {a('remaining.addConversation')}
                  </Button>
                  <Button
                    className={SELECTION_ACTION_CLASS}
                    icon={<Plus size={14} />}
                    disabled={state.projects.length === 0}
                    onClick={openSaveDialog}
                    size="sm"
                    variant="ghost"
                  >
                    {a('remaining.importAnswer')}
                  </Button>
                  <Divider
                    orientation="vertical"
                    className="!h-[var(--vds-space-4)] !min-h-0 !self-center !m-0"
                  />
                  <Button
                    className={SELECTION_ACTION_CLASS}
                    icon={<Copy size={14} />}
                    onClick={() => void copySelection()}
                    size="sm"
                    variant="ghost"
                  >
                    {a('remaining.copyText')}
                  </Button>
                </div>
              }
              className="w-max max-w-none [&_[role=toolbar]]:!p-[calc(var(--vds-space-2)-var(--vds-border-width-1))]"
              label={a('remaining.selectionActions')}
            />
          </div>
        </Portal>
      ) : null}
      <ResourceSaveDialog
        description={a('remaining.excerptDescription')}
        error={saveError === null ? '' : a('remaining.saveFailed', { detail: saveError })}
        fixedSuffix=".md"
        location={saveLocation}
        onLocationChange={setSaveLocation}
        onOpenChange={setSaveDialogOpen}
        onSubmit={() => void saveSelectionResource()}
        open={saveDialogOpen}
        projectName={targetProject?.name ?? a('remaining.currentProject')}
        projectOptions={sessionProject ? undefined : state.projects}
        selectedProjectId={targetProjectId}
        onProjectChange={sessionProject ? undefined : selectTargetProject}
        saving={saving}
        summary={
          sourceCount === null
            ? t('answerSave.unknown')
            : t('answerSave.summary', { count: sourceCount })
        }
        title={a('remaining.importAnswer')}
        tree={resourceTree}
      />
    </div>
  )
}
