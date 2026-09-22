import { assistantFailureDetail } from './failure'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, MessageCirclePlus, Plus } from 'lucide-react'

import type { ResourceLocationRef } from '../../contracts/resources'
import { isCitationUrl } from '../../contracts/citations'
import { Icon } from '../../icons'
import type { AnswerSource } from '../../model'
import { activeThread, useApp } from '../../store'
import { Markdown } from '../../components/primitive/Markdown'
import { writeClipboard } from '../../components/primitive/clipboard'
import { mappedSourceBoundary } from '../../components/markdown/source'
import {
  Button,
  FloatingToolbar,
  IconButton,
  Input,
  useToast
} from '../../components/ui'
import { expandedResourceAncestors } from '../../contracts/resources'
import { citationSources, fetchResourceDirectoryTree, saveAnswerSelectionToResource } from './api'
import { ANSWER_ANNOTATION_LOCATION, sha256Text } from './anchors'
import { ResourceSaveDialog } from './Save'
import { CitationLink, CitationSources, WebCitationLink } from './Citations'
import { AnnotationBadgeNote, annotationDisplay } from './Notes'
import { defaultExcerptName } from './names'
import { shouldClosePointerToolbar } from './selection-toolbar'
import { SessionFileLink } from './Links'

const ANSWER_ID_PREFIX = 'answer:'
const ITEM_ID_PREFIX = 'item:'
// 设计稿: 注释标识悬浮在被注释文本结束处的上方(蓝色气泡+序号);
// 零宽行内锚点不参与文字排版, 浮层相对锚点抬升到当前行上方。
const INLINE_MARKER_ANCHOR_CLASS = 'relative inline-block h-0 w-0'
const INLINE_MARKER_FLOAT_CLASS = 'absolute bottom-full left-0 z-10 mb-[12px] -translate-x-1/2'
const ANSWER_ANNOTATION_FOCUS_DURATION_MS = 2400
const CONVERSATION_STREAM_SELECTOR = '.conversation-stream'
const SELECTION_TOOLBAR_MAX_WIDTH_PX = 390
const SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX = 16
const ANNOTATION_ERROR_MESSAGES = {
  answer_revision_conflict: 'remaining.revisionConflict',
  answer_quote_mismatch: 'remaining.quoteMismatch',
  assistant_session_unavailable: 'remaining.sessionUnavailable'
} as const
const ANNOTATION_SAVE_FALLBACK_MESSAGE = 'remaining.annotationFailed'
const ANSWER_ANNOTATION_SAVE_TOAST_ID = 'answer-annotation-save-failed'
// 选区菜单项共用一套样式：默认不上底色，仅 hover 时高亮，避免某一项看起来像已选中。
const SELECTION_ACTION_CLASS = 'w-full justify-start rounded-[var(--vds-radius-3)] !border-0 px-3 !text-[var(--vds-text-primary)] !shadow-none hover:!bg-[var(--vds-surface-hover)]'

interface SelectionDraft {
  clientAnnotationId: string
  annotationId?: string
  startUtf16: number
  endUtf16: number
  previewText: string
  clipboardText: string
  left: number
  width: number
  top: number
  selectionTop: number
  selectionBottom: number
  placement: 'above' | 'below'
  mode: 'actions' | 'comment'
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
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement
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
    const prefix = Array.from(element.childNodes).slice(0, offset)
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
  citationEnabled,
  text,
  eventSeq,
  evidence,
  selectionEnabled,
  turnId,
  messageId,
  markdownClassName,
  answerSources
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
}): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('components')
  const { t: a } = useTranslation('assistant')
  const { toast } = useToast()
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const commentRef = useRef('')
  const annotationSavingRef = useRef(false)
  const [draft, setDraft] = useState<SelectionDraft | null>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    const toolbar = toolbarRef.current
    if (!draft || !root || !toolbar) return
    const stream = root.closest<HTMLElement>(CONVERSATION_STREAM_SELECTOR)
    const updatePosition = (): void => {
      const rootBounds = root.getBoundingClientRect()
      const streamBounds = stream?.getBoundingClientRect()
      const visibleTop = Math.max(0, streamBounds?.top ?? 0) + SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX
      const visibleBottom = Math.min(window.innerHeight, streamBounds?.bottom ?? window.innerHeight)
        - SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX
      const toolbarHeight = toolbar.getBoundingClientRect().height
      const selectionTop = rootBounds.top + draft.selectionTop
      const selectionBottom = rootBounds.top + draft.selectionBottom
      const spaceBelow = visibleBottom - selectionBottom
      const spaceAbove = selectionTop - visibleTop
      const placement = spaceBelow >= toolbarHeight || spaceBelow >= spaceAbove ? 'below' : 'above'
      const preferredTop = placement === 'below' ? selectionBottom : selectionTop - toolbarHeight
      const viewportTop = Math.max(visibleTop, Math.min(preferredTop, visibleBottom - toolbarHeight))
      const top = viewportTop - rootBounds.top + (placement === 'above' ? toolbarHeight : 0)
      setDraft(current => current && (current.top !== top || current.placement !== placement)
        ? { ...current, top, placement }
        : current)
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
  }, [draft])
  const draftRef = useRef<SelectionDraft | null>(null)
  useEffect(() => { draftRef.current = draft }, [draft])
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sourceCount, setSourceCount] = useState<number | null>(null)
  const [saveLocation, setSaveLocation] = useState<ResourceLocationRef>({ parent: '', name: '' })
  const [resourceTree, setResourceTree] = useState(state.resource.tree)
  const [targetProjectId, setTargetProjectId] = useState('')
  const thread = activeThread(state)
  const sessionProject = state.projects.find((project) => project.path === thread.projectPath) ?? null
  const targetProject = state.projects.find((project) => project.id === targetProjectId) ?? null
  const answerId = messageId
    ?? (eventSeq !== undefined ? `${ANSWER_ID_PREFIX}${eventSeq}` : null)
  const originalQuestion = useMemo(() => {
    const item = thread.conversation.find(
      (candidate) => candidate.kind === 'user' && candidate.turnId === turnId
    )
    return item?.kind === 'user' ? item.text : ''
  }, [thread.conversation, turnId])
  const annotations = useMemo(() => {
    if (!answerId) return []
    const itemId = messageId?.startsWith(ITEM_ID_PREFIX)
      ? messageId.slice(ITEM_ID_PREFIX.length)
      : null
    // 内联标识由注释实体驱动: 笔记即使已随轮次提交或从 composer 队列移除,
    // 消息列表中被注释文本上的蓝色标识仍需持续展示。
    return state.aiPanel.annotations.filter((annotation) => (
      annotation.answer_id === answerId
      // 身份漂移容忍: 历史回放后 vendor item id 或旧 answer 方案可能与
      // 注释保存时的 id 不一致, 用来源身份回退匹配, 保证内联标识仍渲染。
      || (itemId !== null && annotation.source_item_id === itemId)
      || (
        eventSeq !== undefined
        && annotation.source_product_seq === eventSeq
        && (!turnId || annotation.source_turn_id === turnId)
      )
    ))
  }, [answerId, eventSeq, messageId, state.aiPanel.annotations, turnId])
  const annotationFocus = state.aiPanel.answerAnnotationFocus
  const focusedAnnotation = useMemo(() => {
    if (
      !answerId
      || annotationFocus?.answerId !== answerId
      || annotationFocus.status !== ANSWER_ANNOTATION_LOCATION.AVAILABLE
    ) return null
    return state.aiPanel.annotations.find(
      (annotation) => annotation.annotation_id === annotationFocus.annotationId
    ) ?? null
  }, [annotationFocus, answerId, state.aiPanel.annotations])

  const captureSelection = (): void => {
    const root = rootRef.current
    const selection = window.getSelection()
    if (!selectionEnabled || !root || !selection || selection.isCollapsed || selection.rangeCount !== 1 || !answerId) return
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
    const toolbarWidth = Math.min(
      SELECTION_TOOLBAR_MAX_WIDTH_PX,
      Math.max(0, rootBounds.width - SELECTION_TOOLBAR_VIEWPORT_MARGIN_PX)
    )
    const toolbarHalfWidth = toolbarWidth / 2
    setComment('')
    commentRef.current = ''
    setSaveError(null)
    setDraft({
      clientAnnotationId: crypto.randomUUID(),
      startUtf16: start,
      endUtf16: end,
      previewText,
      clipboardText,
      width: toolbarWidth,
      left: Math.min(
        rootBounds.width - toolbarHalfWidth,
        Math.max(
          toolbarHalfWidth,
          selectionBounds.left + selectionBounds.width / 2 - rootBounds.left
        )
      ),
      top: selectionBounds.bottom - rootBounds.top,
      selectionTop: selectionBounds.top - rootBounds.top,
      selectionBottom: selectionBounds.bottom - rootBounds.top,
      placement: 'below',
      mode: 'actions'
    })
  }

  const copySelection = async (): Promise<void> => {
    if (!draft) return
    try {
      await writeClipboard(draft.clipboardText)
      setDraft(current => current === draft ? null : current)
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
    setResourceTree(
      state.homeSelectedProjectId === project.id ? state.resource.tree : []
    )
    setSaveError(null)
    setSaveDialogOpen(true)
    setSourceCount(null)
    if (answerId && thread.sessionId) {
      void sha256Text(text)
        .then((revision) => citationSources(thread.sessionId!, answerId, revision, {
          start: draft.startUtf16,
          end: draft.endUtf16
        }))
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
    const messageKey = Object.prototype.hasOwnProperty.call(
      ANNOTATION_ERROR_MESSAGES,
      error ?? ''
    )
      ? ANNOTATION_ERROR_MESSAGES[error as keyof typeof ANNOTATION_ERROR_MESSAGES]
      : ANNOTATION_SAVE_FALLBACK_MESSAGE
    toast({
      id: ANSWER_ANNOTATION_SAVE_TOAST_ID,
      tone: 'error',
      title: a(messageKey)
    })
  }

  const addAnnotation = async (): Promise<void> => {
    if (!draft || !answerId || annotationSavingRef.current) return
    annotationSavingRef.current = true
    setSaving(true)
    try {
      const selectedMarkdown = text.slice(draft.startUtf16, draft.endUtf16)
      const [answerRevision, selectedTextHash] = await Promise.all([
        sha256Text(text),
        sha256Text(selectedMarkdown)
      ])
      const result = await act.createAnswerAnnotation(answerId, {
        client_annotation_id: draft.clientAnnotationId,
        answer_revision: answerRevision,
        start_utf16: draft.startUtf16,
        end_utf16: draft.endUtf16,
        selected_text_hash: selectedTextHash,
        preview_text: draft.previewText,
        comment: '',
        enqueue: true
      })
      if (!result.ok || !result.annotation) {
        showAnnotationError(result.error)
        return
      }
      const annotationId = result.annotation.annotation_id
      setDraft(current => current?.clientAnnotationId === draft.clientAnnotationId
        ? { ...current, annotationId, mode: 'comment' }
        : current)
      window.getSelection()?.removeAllRanges()
    } catch {
      showAnnotationError()
    } finally {
      annotationSavingRef.current = false
      setSaving(false)
    }
  }

  const saveAnnotation = async (): Promise<void> => {
    if (!draft?.annotationId || annotationSavingRef.current) return
    annotationSavingRef.current = true
    setSaving(true)
    try {
      const annotation = state.aiPanel.annotations.find(item => item.annotation_id === draft.annotationId)
      const unchanged = annotation?.comment === commentRef.current.trim()
      if (unchanged || await act.updateAnswerAnnotation(draft.annotationId, commentRef.current)) {
        setDraft(current => current?.clientAnnotationId === draft.clientAnnotationId ? null : current)
      } else {
        showAnnotationError()
      }
    } finally {
      annotationSavingRef.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!draft || saveDialogOpen) return undefined
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!shouldClosePointerToolbar(
        event.button,
        toolbarRef.current?.contains(target) ?? false,
        rootRef.current?.contains(target) ?? false
      )) return
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
  useEffect(() => { captureSelectionRef.current = captureSelection })
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

  const displayedAnnotations = focusedAnnotation
    && !annotations.some((annotation) => annotation.annotation_id === focusedAnnotation.annotation_id)
    ? [...annotations, focusedAnnotation]
    : annotations
  const answerAnnotations = displayedAnnotations.map((annotation) => ({
    id: annotation.annotation_id,
    start_utf16: annotation.start_utf16,
    end_utf16: annotation.end_utf16,
    focused: annotation.annotation_id === focusedAnnotation?.annotation_id
  }))

  useEffect(() => {
    if (!focusedAnnotation || !annotationFocus || !rootRef.current) return undefined
    const target = Array.from(
      rootRef.current.querySelectorAll<HTMLElement>('[data-scholarseed-answer-annotation-id]')
    ).find((element) => (
      element.dataset.scholarseedAnswerAnnotationId === focusedAnnotation.annotation_id
    ))
    if (!target) return undefined
    const stream = target.closest<HTMLElement>(CONVERSATION_STREAM_SELECTOR)
    if (stream) {
      const streamBounds = stream.getBoundingClientRect()
      const targetBounds = target.getBoundingClientRect()
      const targetCenter = targetBounds.top + targetBounds.height / 2
      const streamCenter = streamBounds.top + streamBounds.height / 2
      stream.scrollTo({
        top: stream.scrollTop + targetCenter - streamCenter,
        behavior: 'smooth'
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
      sha256Text(selectedMarkdown)
    ])
    const result = await saveAnswerSelectionToResource({
      sessionId: thread.sessionId,
      projectId: targetProject.id,
      answerId,
      answerRevision,
      startUtf16: draft.startUtf16,
      endUtf16: draft.endUtf16,
      selectedTextHash,
      selectedMarkdown,
      question: originalQuestion,
      location: saveLocation
    }, a)
    setSaving(false)
    if (!result.ok || !result.node) {
      setSaveError(assistantFailureDetail(result) ?? '')
      return
    }
    setSaveDialogOpen(false)
    if (state.homeSelectedProjectId === targetProject.id) {
      const expanded = expandedResourceAncestors(resourceTree, saveLocation.parent, state.resource.expanded)
      if (saveLocation.parent) expanded[saveLocation.parent] = true
      await act.reloadResourceTree(expanded)
      act.selectResourceFile(result.node.path)
    }
    act.noticeResource('ok', { key: 'feedback.savedResource', name: result.node.name }, {
      path: result.node.path,
      projectId: targetProject.id
    })
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
        answerAnnotations={answerAnnotations}
        className={markdownClassName ?? "md-agent"}
        evidence={evidence}
        renderSessionFileLink={thread.sessionId ? (path, children) => <SessionFileLink sessionId={thread.sessionId!} path={path} onOpen={() => act.openFilePreview({ sessionId: thread.sessionId!, path })}>{children}</SessionFileLink> : undefined}
        citationUrls={answerSources?.flatMap(source => source.citation_urls)}
        renderCitation={answerId && thread.sessionId && citationEnabled ? (range, children, href) => {
          const source = answerSources?.find(candidate => candidate.citation_urls.includes(href))
          if (source?.kind === 'searched') {
            return <WebCitationLink key={`${thread.sessionId}:${answerId}:${range.start}`} source={source} />
          }
          if (source?.kind === 'receipt') {
            return <CitationLink key={`${thread.sessionId}:${answerId}:${range.start}`} sessionId={thread.sessionId!} answerId={answerId} text={text} range={range} displayNumber={source.number}>{children}</CitationLink>
          }
          return isCitationUrl(href)
            ? <CitationLink key={`${thread.sessionId}:${answerId}:${range.start}`} sessionId={thread.sessionId!} answerId={answerId} text={text} range={range}>{children}</CitationLink>
            : undefined
        } : undefined}
        renderAnswerAnnotationMarker={(marker) => {
          const annotation = displayedAnnotations.find((item) => item.annotation_id === marker.id)
          if (!annotation) return null
          const number = displayedAnnotations.findIndex(item => item.annotation_id === marker.id) + 1
          const noteText = annotation.comment || annotation.preview_text
          return (
            <span className={INLINE_MARKER_ANCHOR_CLASS} key={marker.id}>
              <span className={INLINE_MARKER_FLOAT_CLASS}>
                <AnnotationBadgeNote
                  annotation={annotationDisplay(annotation)}
                  ariaLabel={a('remaining.annotationLabel', { number, comment: noteText })}
                  noteText={noteText}
                  number={number}
                  onRemove={(annotationId) => act.deleteAnswerAnnotation(annotationId)}
                  onSave={(annotationId, nextComment) => (
                    act.updateAnswerAnnotation(annotationId, nextComment)
                  )}
                />
              </span>
            </span>
          )
        }}
        sourceMapped
        text={text}
      />
      {answerId && thread.sessionId && citationEnabled && <CitationSources sessionId={thread.sessionId} answerId={answerId} text={text} answerSources={answerSources} />}
      {draft ? (
        <div
          className={`answer-selection-anchor flex min-w-0 flex-col items-center -translate-x-1/2 ${draft.placement === 'above' ? '-translate-y-full pb-2' : 'pt-2'
            }`}
          ref={toolbarRef}
          style={{ left: draft.left, top: draft.top, width: draft.width }}
          onMouseUp={(event) => event.stopPropagation()}
        >
          {draft.mode === 'actions' ? (
            <FloatingToolbar
              actions={(
                <div className="flex w-full flex-col">
                  <Button
                    className={SELECTION_ACTION_CLASS}
                    icon={<Copy size={14} />}
                    onClick={() => void copySelection()}
                    size="sm"
                    variant="ghost"
                  >
                    {a('remaining.copyText')}
                  </Button>
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
                </div>
              )}
              className="w-[190px] max-w-full !rounded-[var(--vds-radius-5)]"
              label={a('remaining.selectionActions')}
            />
          ) : (
            <div className="flex w-[328px] max-w-full min-w-0 flex-col gap-1">
              <FloatingToolbar
                actions={(
                  <>
                    <Input
                      aria-label={a('remaining.comment')}
                      autoFocus
                      className="h-8 w-full min-w-0 rounded-[var(--vds-radius-3)] border border-solid border-transparent !bg-transparent px-2 text-[length:var(--vds-font-body-lv1)] !shadow-none placeholder:text-[var(--vds-text-placeholder)] focus:outline-none focus-visible:border-[var(--vds-border-brand)] focus-visible:!shadow-none"
                      disabled={saving}
                      maxLength={600}
                      onChange={(event) => {
                        commentRef.current = event.target.value
                        setComment(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                        event.preventDefault()
                        void saveAnnotation()
                      }}
                      placeholder={a('remaining.optionalComment')}
                      size="sm"
                      unstyled
                      value={comment}
                    />
                    <IconButton
                      disabled={saving}
                      icon={<Icon name="close" size={13} />}
                      label={a('remaining.cancelAdd')}
                      onClick={closeDraft}
                      size="sm"
                      variant="ghost"
                    />
                  </>
                )}
                className="min-h-10 w-full !rounded-[var(--vds-radius-4)] !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] shadow-[var(--vds-shadow-md)] [&_.vds-field]:flex-1 [&_.vds-floating-toolbar__actions]:gap-1 [&_.vds-floating-toolbar__actions]:p-1.5"
                expanded
                label={a('remaining.addAnnotation')}
              />
            </div>
          )}
        </div>
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
        summary={sourceCount === null ? t('answerSave.unknown') : t('answerSave.summary', { count: sourceCount })}
        title={a('remaining.importAnswer')}
        tree={resourceTree}
      />
    </div>
  )
}
