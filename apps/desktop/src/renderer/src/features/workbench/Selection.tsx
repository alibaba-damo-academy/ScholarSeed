import { useTranslation } from 'react-i18next'
import { useTranslationBackend } from '../translation/context'
import { Languages, MessageCirclePlus } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Divider, FloatingToolbar } from '../../components/ui'
import { Icon } from '../../icons'
import { useAssistantIngress } from '../assistant/ingress'
import { RESOURCE_AI_SUGGESTION_SELECTOR, ResourceSuggestion } from '../resources/Suggestion'
import type { ResourceAction, ResourceInput } from '../resources/ai'
import type { SelectionAnchor } from '../../contracts/workbench'
import { digestText } from './api'
import { addSelectionContext } from './context'
import {
  useSelectionActionRegistry,
  selectionAnnotationFor,
  selectionReplacementFor,
  useSelectionActions,
  selectionToolbarVisible,
} from './actions'
import { documentSelectionInteractionProps, retainsDocumentSelection } from './focus'
import {
  DEFAULT_SELECTION_TOOLBAR_WIDTH,
  SELECTION_VIEWPORT_MARGIN,
  constrainSelectionSurface,
  selectionActionPosition,
  selectionSurfaceBoundary,
  selectionSurfacePosition,
} from './placement'
import { pdfSelectionShape } from './pdf/geometry'
import { PdfSelectionActions } from './pdf/Tools'
import {
  focusedSelectionPresentation,
  useDocumentWorkspace,
  useWorkspaceController,
} from './workspace'

const MAX_DRAFT_CONTEXT = 36000
const SUGGESTION_TOOLBAR_CONTROLS_WIDTH = 110
const CLIPPING_OVERFLOW_VALUES = new Set(['auto', 'clip', 'hidden', 'scroll'])
const DEFAULT_SELECTION_ACTION_ORDER = 5
const ADD_CONTEXT_ACTION_ORDER = 50
const DEFAULT_SELECTION_ACTION_ID = 'selection-defaults'
const ADD_CONTEXT_ACTION_ID = 'selection-add-context'
const SELECTION_MINIMUM_HEIGHT = 100
const SELECTION_EXPANDED_HEIGHT = 360

interface ActiveSuggestion {
  action: ResourceAction
  changeVersion: number
  identity: string
  onAnnotate?: (output: string) => Promise<boolean>
  onApply?: (output: string) => Promise<string | null>
  pinned: boolean
  point: { x: number; y: number }
  selectedText: string
  selection: SelectionAnchor
  snapshot: Promise<ResourceInput>
  tabId: string
}

function selectionAnchorIsVisible(point: { x: number; y: number }): boolean {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return true
  const range = selection.getRangeAt(0)
  let ancestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
  let bottom = window.innerHeight
  let left = 0
  let right = window.innerWidth
  let top = 0
  for (; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    const clipsX = CLIPPING_OVERFLOW_VALUES.has(style.overflowX)
    const clipsY = CLIPPING_OVERFLOW_VALUES.has(style.overflowY)
    if (!clipsX && !clipsY) continue
    const bounds = ancestor.getBoundingClientRect()
    if (clipsX) {
      left = Math.max(left, bounds.left)
      right = Math.min(right, bounds.right)
    }
    if (clipsY) {
      top = Math.max(top, bounds.top)
      bottom = Math.min(bottom, bounds.bottom)
    }
  }
  return point.x > left && point.x < right && point.y > top && point.y < bottom
}

function suggestionOwnsFocus(): boolean {
  const focused = document.activeElement
  return focused instanceof Element && Boolean(focused.closest(RESOURCE_AI_SUGGESTION_SELECTOR))
}

export function SelectionActionHost(): React.JSX.Element | null {
  const { settings: translationSettings } = useTranslationBackend()
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const registry = useSelectionActionRegistry()
  const current = focusedSelectionPresentation(workspace)
  const contributions = useSelectionActions(current?.tab.id ?? '')
  const toolbarUnavailable = Boolean(
    current?.selection.locator.kind === 'pdf' &&
    (translationSettings?.toolbar === false || translationSettings?.preferencesReady === false)
  )
  const forcedVisible = contributions.some((item) => item.forceVisible)
  const currentIdentity = current?.presentation.fingerprint ?? ''
  const focusedTabId = workspace.focusedTabId ?? ''
  const [active, setActive] = useState<ActiveSuggestion | null>(null)
  const activeTab = active ? workspace.tabs[active.tabId] : null
  const activeSession = activeTab ? workspace.sessions[activeTab.sessionId] : null
  const activeSourceCurrent = Boolean(
    active &&
    activeSession?.id === active.selection.document_session_id &&
    activeSession.revision === active.selection.revision
  )
  const currentVisible = Boolean(
    current &&
    (!toolbarUnavailable || forcedVisible) &&
    current.selection.status === 'exact' &&
    current.session.capabilities.can_select &&
    current.presentation.visible !== false &&
    (current.selection.locator.kind === 'pdf' ||
      selectionAnchorIsVisible(current.presentation.point))
  )
  useEffect(() => {
    if (!active || active.pinned) return undefined
    if (active.selection.locator.kind === 'pdf') return undefined
    const dismissOutsidePointer = (event: PointerEvent): void => {
      if (!retainsDocumentSelection(null, event.target)) setActive(null)
    }
    document.addEventListener('pointerdown', dismissOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', dismissOutsidePointer, true)
  }, [active])
  useEffect(() => {
    if (
      active &&
      (!activeSourceCurrent ||
        (active.selection.locator.kind !== 'pdf' && active.tabId !== focusedTabId) ||
        (!active.pinned &&
          !suggestionOwnsFocus() &&
          ((active.tabId === focusedTabId && active.identity !== currentIdentity) ||
            (active.action !== 'translate' && !currentVisible))))
    )
      setActive(null)
  }, [active, activeSourceCurrent, currentIdentity, currentVisible, focusedTabId])
  const suggestionVisible = Boolean(active && activeSourceCurrent && active.tabId === focusedTabId)
  const activeAttachedToSelection = Boolean(
    active &&
    active.action !== 'translate' &&
    suggestionVisible &&
    currentVisible &&
    active.identity === currentIdentity
  )
  const openSuggestion = (suggestion: ActiveSuggestion): void => {
    const captured = suggestion
    const contributions = registry.get(captured.tabId)
    const replaceSelection = selectionReplacementFor(contributions)
    const annotateResult = selectionAnnotationFor(contributions)
    setActive({
      ...captured,
      onAnnotate:
        captured.action !== 'polish' && annotateResult
          ? async (output) => {
              const annotate = selectionAnnotationFor(registry.get(captured.tabId))
              if (!annotate) return false
              const result = await annotate({
                selection: captured.selection,
                body: output,
              })
              return result.ok
            }
          : undefined,
      onApply: replaceSelection
        ? async (output) => {
            const latest = focusedSelectionPresentation(controller.getSnapshot())
            if (
              latest?.presentation.fingerprint !== captured.identity ||
              latest.session.changeVersion !== captured.changeVersion
            )
              return 'selection_changed'
            const replace = selectionReplacementFor(registry.get(captured.tabId))
            if (!replace) return 'unsupported'
            const result = await replace({
              selection: captured.selection,
              replacement: output,
              expectedChangeVersion: captured.changeVersion,
              expectedFingerprint: captured.identity,
            })
            return result.ok
              ? null
              : result.error === 'replacement_timeout'
                ? 'replacement_timeout'
                : 'replacement_stale'
          }
        : undefined,
    })
  }
  if (!current && !suggestionVisible) return null
  if (toolbarUnavailable && !forcedVisible) return null
  return (
    <SelectionActions
      key={active && suggestionVisible ? active.identity : currentIdentity}
      active={suggestionVisible ? active : null}
      activeAttachedToSelection={activeAttachedToSelection}
      activeAction={activeAttachedToSelection ? (active?.action ?? null) : null}
      onCloseSuggestion={() => setActive(null)}
      onOpenSuggestion={openSuggestion}
      onPinnedChange={(pinned) => setActive((value) => (value ? { ...value, pinned } : value))}
    />
  )
}

function SelectionActions({
  active,
  activeAttachedToSelection,
  activeAction,
  onCloseSuggestion,
  onOpenSuggestion,
  onPinnedChange,
}: {
  active: ActiveSuggestion | null
  activeAttachedToSelection: boolean
  activeAction: ResourceAction | null
  onCloseSuggestion: () => void
  onOpenSuggestion: (suggestion: ActiveSuggestion) => void
  onPinnedChange: (pinned: boolean) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { t: w } = useTranslation('workbench')
  const { t: pdfText } = useTranslation('pdf')
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const current = focusedSelectionPresentation(workspace)
  const registry = useSelectionActionRegistry()
  const ingress = useAssistantIngress()
  const contributions = useSelectionActions(current?.tab.id ?? '')
  const expanded = contributions.some((item) => item.expanded)
  const toolbarEnabled = contributions.every((item) => item.toolbarEnabled !== false)
  const [error, setErrorKey] = useState<
    '' | 'selectionActions.contextSaveFailed' | 'selectionActions.contextAddFailed'
  >('')
  const toolbarObserverRef = useRef<ResizeObserver | null>(null)
  const [width, setWidth] = useState(DEFAULT_SELECTION_TOOLBAR_WIDTH)
  const [height, setHeight] = useState(SELECTION_MINIMUM_HEIGHT)
  const [geometry, setGeometry] = useState<{
    left: number
    top: number
    width: number
    height?: number
  } | null>(null)
  const toolbarRef = useCallback((node: HTMLDivElement | null): void => {
    toolbarObserverRef.current?.disconnect()
    toolbarObserverRef.current = null
    if (!node) return
    const updateWidth = (): void => {
      const bounds = node.getBoundingClientRect()
      setWidth(bounds.width)
      setHeight(bounds.height)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    toolbarObserverRef.current = observer
  }, [])
  useEffect(() => {
    if (active && activeAttachedToSelection && expanded) onCloseSuggestion()
  }, [active, activeAttachedToSelection, expanded, onCloseSuggestion])
  useEffect(() => {
    if (active && !toolbarEnabled) onCloseSuggestion()
  }, [active, toolbarEnabled, onCloseSuggestion])
  const renderSuggestion = (
    position?: ReturnType<typeof selectionActionPosition>,
    toolbarActions?: React.ReactNode
  ): React.JSX.Element | null =>
    active ? (
      <div {...documentSelectionInteractionProps} className="contents">
        <ResourceSuggestion
          key={`${active.identity}:${active.action}`}
          action={active.action}
          anchorPosition={position}
          anchorWidth={position?.width}
          identity={active.identity}
          selectedText={active.selectedText}
          point={active.point}
          snapshot={active.snapshot}
          pinned={active.pinned}
          toolbarActions={toolbarActions}
          toolbarLabel={w('selection.label')}
          onPinnedChange={onPinnedChange}
          onClose={onCloseSuggestion}
          onAnnotate={active.onAnnotate}
          onApply={active.onApply}
        />
      </div>
    ) : null
  if (active && !activeAttachedToSelection) return renderSuggestion()
  if (
    !current ||
    !selectionToolbarVisible(contributions) ||
    current.selection.status !== 'exact' ||
    !current.session.capabilities.can_select ||
    current.presentation.visible === false ||
    (current.selection.locator.kind !== 'pdf' &&
      !selectionAnchorIsVisible(current.presentation.point))
  )
    return null
  const { session, selection, presentation, tab } = current
  const source = session.source
  const resource = source.kind === 'project' && Boolean(source.project)
  const literature = source.kind === 'literature'
  const artifact = source.kind === 'session-artifact'
  const integratedWidth = Math.min(
    width + SUGGESTION_TOOLBAR_CONTROLS_WIDTH,
    window.innerWidth - SELECTION_VIEWPORT_MARGIN * 2
  )
  const anchorPosition = selectionActionPosition(
    presentation.point,
    expanded || Boolean(active),
    active ? integratedWidth : width
  )
  const pdf = selection.locator.kind === 'pdf'
  const boundary = (pdf && presentation.boundary) || selectionSurfaceBoundary()
  const placement =
    pdf && presentation.rect
      ? selectionSurfacePosition(
          presentation.rect,
          {
            width,
            height: expanded ? Math.max(height, SELECTION_EXPANDED_HEIGHT) : height,
          },
          undefined,
          { allowOverlap: expanded, boundary }
        )
      : { ...anchorPosition, height }
  const position = pdf
    ? constrainSelectionSurface(
        { ...(geometry ?? placement), height: geometry?.height ?? placement.height },
        boundary
      )
    : (geometry ?? placement)
  const moveSurface = (delta: { x: number; y: number }): void => {
    setGeometry((previous) => {
      const box = constrainSelectionSurface(
        { ...(previous ?? placement), height: previous?.height ?? height },
        boundary
      )
      const moved = constrainSelectionSurface(
        { ...box, left: box.left + delta.x, top: box.top + delta.y },
        boundary
      )
      return {
        ...moved,
        height: previous?.height ? moved.height : undefined,
      }
    })
  }
  const resizeSurface = (delta: { x: number; y: number }, edge = { x: 1, y: 1 }): void => {
    setGeometry((previous) => {
      const box = constrainSelectionSurface(
        { ...(previous ?? placement), height: previous?.height ?? height },
        boundary
      )
      const right = box.left + box.width
      const bottom = box.top + (box.height ?? height)
      const minimumWidth = Math.min(DEFAULT_SELECTION_TOOLBAR_WIDTH, boundary.right - boundary.left)
      const minimumHeight = Math.min(SELECTION_EXPANDED_HEIGHT, boundary.bottom - boundary.top)
      const left =
        edge.x < 0
          ? Math.max(boundary.left, Math.min(right - minimumWidth, box.left + delta.x))
          : box.left
      const top =
        edge.y < 0
          ? Math.max(boundary.top, Math.min(bottom - minimumHeight, box.top + delta.y))
          : box.top
      return {
        left,
        top,
        width:
          edge.x < 0
            ? right - left
            : Math.min(boundary.right - left, Math.max(minimumWidth, box.width + delta.x * edge.x)),
        height:
          edge.y < 0
            ? bottom - top
            : Math.min(
                boundary.bottom - top,
                Math.max(minimumHeight, box.height + delta.y * edge.y)
              ),
      }
    })
  }
  const add = async (): Promise<void> => {
    if (!resource && !literature && !artifact) return
    setErrorKey('')
    setErrorKey((await addSelectionContext(session, selection, controller, ingress)) ?? '')
  }
  const snapshot = async (): Promise<ResourceInput> => {
    if (!resource) throw new Error('selection_unsupported')
    const [hash, shapeHash] = await Promise.all([
      digestText(selection.text),
      selection.locator.kind === 'pdf'
        ? digestText(pdfSelectionShape(selection.text))
        : Promise.resolve(''),
    ])
    const locator =
      selection.locator.kind === 'pdf'
        ? { ...selection.locator, text_shape_hash: shapeHash }
        : selection.locator
    const referenceOnly =
      selection.locator.kind === 'calc' && selection.locator.content_mode === 'reference'
    let sourceRevision = session.revision
    // A reference needs persisted bytes. Inline CSV drafts keep the existing draft path.
    if (referenceOnly && session.dirty) {
      const saved = await controller.save(session.id)
      const committed = controller.getSnapshot().sessions[session.id]
      if (!saved || !committed || committed.dirty) throw new Error('selection_context_save_failed')
      sourceRevision = committed.revision
    }
    const context = referenceOnly
      ? selection.text
      : (selection.context_text ?? session.text ?? selection.text)
    const start = Math.max(
      0,
      context.indexOf(selection.text) - Math.floor((MAX_DRAFT_CONTEXT - selection.text.length) / 2)
    )
    return {
      source: {
        project_id: source.project!,
        source_id: source.path,
        source_revision: sourceRevision,
      },
      scope: 'selection',
      selection: { locator, selected_text: selection.text, selected_text_hash: hash },
      ...(session.dirty && !referenceOnly
        ? {
            draft: {
              change_version: session.changeVersion,
              selected_text: selection.text,
              context_text: context.slice(start, start + MAX_DRAFT_CONTEXT),
              selected_text_hash: hash,
            },
          }
        : {}),
    }
  }
  const open = (action: ResourceAction): void => {
    const selectedText = selection.text
    const requestSnapshot = snapshot()
    registry.dismiss(tab.id)
    onOpenSuggestion({
      action,
      changeVersion: session.changeVersion,
      identity: presentation.fingerprint,
      pinned: false,
      point: presentation.point,
      selectedText,
      selection,
      snapshot: requestSnapshot,
      tabId: tab.id,
    })
  }
  const replacesDefaults = contributions.some((item) => item.replacesDefaults)
  const orderedActions = [
    ...contributions.map((item) => ({ id: item.id, order: item.order, actions: item.actions })),
    ...(resource && !replacesDefaults
      ? [
          {
            id: DEFAULT_SELECTION_ACTION_ID,
            order: DEFAULT_SELECTION_ACTION_ORDER,
            actions: (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="sparkle" size={14} />}
                  aria-pressed={activeAction === 'explain'}
                  onClick={() => {
                    if (activeAction !== 'explain') open('explain')
                  }}
                >
                  {pdf ? pdfText('selectionExplain') : w('selection.explain')}
                </Button>
                {session.capabilities.can_edit &&
                  selection.locator.kind !== 'pdf' &&
                  !(
                    selection.locator.kind === 'calc' &&
                    selection.locator.content_mode === 'reference'
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Icon name="doc" size={14} />}
                      aria-pressed={activeAction === 'polish'}
                      onClick={() => {
                        if (activeAction !== 'polish') open('polish')
                      }}
                    >
                      {w('selection.polish')}
                    </Button>
                  )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={pdf ? <Languages size={14} /> : <Icon name="globe" size={14} />}
                  aria-pressed={activeAction === 'translate'}
                  onClick={() => {
                    if (activeAction !== 'translate') open('translate')
                  }}
                >
                  {pdf ? pdfText('selectionTranslate') : w('selection.translate')}
                </Button>
              </>
            ),
          },
        ]
      : []),
    ...(resource || literature || artifact
      ? [
          {
            id: ADD_CONTEXT_ACTION_ID,
            order: ADD_CONTEXT_ACTION_ORDER,
            actions: (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<MessageCirclePlus size={14} />}
                  onClick={() => void add()}
                >
                  {pdf ? pdfText('selectionAddConversation') : w('selection.add')}
                </Button>
              </>
            ),
          },
        ]
      : []),
  ]
    .filter((item) => React.Children.toArray(item.actions).length > 0)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const Actions = pdf ? PdfSelectionActions : React.Fragment
  const toolbarActions = (
    <div className="contents [--vds-control-padding-sm:0_calc(var(--vds-space-1)*1.5)]">
      <Actions>
        {selection.locator.kind === 'calc' && (
          <Badge>
            {selection.locator.sheet} · {selection.locator.range}
          </Badge>
        )}
        {orderedActions.map((item, index) => (
          <React.Fragment key={item.id}>
            {item.actions}
            {item.id === ADD_CONTEXT_ACTION_ID && index < orderedActions.length - 1 && (
              <Divider
                orientation="vertical"
                className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-1)]"
              />
            )}
          </React.Fragment>
        ))}
      </Actions>
    </div>
  )
  if (active) {
    return renderSuggestion(position, toolbarActions)
  }
  return (
    <FloatingToolbar
      {...documentSelectionInteractionProps}
      ref={toolbarRef}
      label={w('selection.label')}
      expanded={expanded}
      data-testid="selection-action-host"
      data-resized={Boolean(geometry?.height)}
      data-ob="pdf-selection"
      className={`vds-selection-actions group/pdf-selection fixed z-[var(--vds-z-floating-panel)] flex w-max max-w-[calc(100vw-24px)] flex-col [&>[role=toolbar]:empty]:hidden ${
        pdf
          ? 'min-h-0 !rounded-[var(--vds-radius-6)] [&>[role=toolbar]]:!flex-nowrap [&>[role=toolbar]]:overflow-x-auto [&>[role=toolbar]]:!gap-[var(--vds-space-half)] [&>[role=toolbar]]:!px-[var(--vds-space-3)] [&>[role=toolbar]]:!py-[var(--vds-space-2)]'
          : 'min-h-[46px]'
      }`}
      style={{
        left: position.left,
        top: position.top,
        ...(pdf
          ? {
              ...(geometry || expanded ? { width: position.width } : {}),
              maxWidth: boundary.right - boundary.left,
              maxHeight: geometry ? boundary.bottom - position.top : placement.height,
              ...(geometry?.height && expanded ? { height: position.height } : {}),
            }
          : {}),
      }}
      actions={toolbarEnabled ? toolbarActions : null}
      onMove={pdf ? moveSurface : undefined}
      moveHandle={pdf ? 'surface' : undefined}
      onResize={pdf && expanded ? resizeSurface : undefined}
      resizeHandle="edges"
    >
      <div
        className={`min-h-0 flex-1 ${contributions.some((item) => item.expanded && item.ownsScroll) ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}
      >
        {error && <p role="alert">{t(error)}</p>}
        {contributions.map((item) =>
          item.expanded ? <React.Fragment key={item.id}>{item.panel}</React.Fragment> : null
        )}
      </div>
    </FloatingToolbar>
  )
}
