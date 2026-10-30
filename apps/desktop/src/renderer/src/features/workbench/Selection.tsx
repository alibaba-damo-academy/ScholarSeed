import { useTranslation } from 'react-i18next'
import { MessageCirclePlus } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Divider, FloatingToolbar } from '../../components/ui'
import { Icon } from '../../icons'
import { focusComposer } from '../../reference'
import { useAssistantIngress } from '../assistant/ingress'
import { RESOURCE_AI_SUGGESTION_SELECTOR, ResourceSuggestion } from '../resources/Suggestion'
import type { ResourceAction, ResourceInput } from '../resources/ai'
import type { SelectionAnchor } from '../../contracts/workbench'
import { captureSelectionSnapshot, digestText } from './api'
import {
  useSelectionActionRegistry,
  selectionAnnotationFor,
  selectionReplacementFor,
  useSelectionActions,
} from './actions'
import { documentSelectionInteractionProps, retainsDocumentSelection } from './focus'
import {
  DEFAULT_SELECTION_TOOLBAR_WIDTH,
  SELECTION_VIEWPORT_MARGIN,
  selectionActionPosition,
} from './placement'
import { pdfSelectionShape } from './pdf/geometry'
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
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const registry = useSelectionActionRegistry()
  const current = focusedSelectionPresentation(workspace)
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
    current.selection.status === 'exact' &&
    current.session.capabilities.can_select &&
    current.presentation.visible !== false &&
    selectionAnchorIsVisible(current.presentation.point)
  )
  useEffect(() => {
    if (!active || active.pinned) return undefined
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
        active.tabId !== focusedTabId ||
        (!active.pinned &&
          !suggestionOwnsFocus() &&
          (active.identity !== currentIdentity ||
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
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const current = focusedSelectionPresentation(workspace)
  const registry = useSelectionActionRegistry()
  const ingress = useAssistantIngress()
  const contributions = useSelectionActions(current?.tab.id ?? '')
  const expanded = contributions.some((item) => item.expanded)
  const [error, setErrorKey] = useState<
    '' | 'selectionActions.contextSaveFailed' | 'selectionActions.contextAddFailed'
  >('')
  const toolbarObserverRef = useRef<ResizeObserver | null>(null)
  const [width, setWidth] = useState(DEFAULT_SELECTION_TOOLBAR_WIDTH)
  const toolbarRef = useCallback((node: HTMLDivElement | null): void => {
    toolbarObserverRef.current?.disconnect()
    toolbarObserverRef.current = null
    if (!node) return
    const updateWidth = (): void => setWidth(node.getBoundingClientRect().width)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    toolbarObserverRef.current = observer
  }, [])
  useEffect(() => {
    if (active && activeAttachedToSelection && expanded) onCloseSuggestion()
  }, [active, activeAttachedToSelection, expanded, onCloseSuggestion])
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
    current.selection.status !== 'exact' ||
    !current.session.capabilities.can_select ||
    current.presentation.visible === false ||
    !selectionAnchorIsVisible(current.presentation.point)
  )
    return null
  const { session, selection, presentation, tab } = current
  const source = session.source
  const resource = source.kind === 'project' && Boolean(source.project)
  const literature = source.kind === 'literature'
  const integratedWidth = Math.min(
    width + SUGGESTION_TOOLBAR_CONTROLS_WIDTH,
    window.innerWidth - SELECTION_VIEWPORT_MARGIN * 2
  )
  const position = selectionActionPosition(
    presentation.point,
    expanded || Boolean(active),
    active ? integratedWidth : width
  )
  const add = async (): Promise<void> => {
    if (!resource && !literature) return
    setErrorKey('')
    let sourceRevision = session.revision
    if (resource && session.dirty) {
      let saved: boolean
      try {
        saved = await controller.save(session.id)
      } catch {
        setErrorKey('selectionActions.contextSaveFailed')
        return
      }
      const committed = controller.getSnapshot().sessions[session.id]
      if (!saved || !committed || committed.dirty) {
        setErrorKey('selectionActions.contextSaveFailed')
        return
      }
      sourceRevision = committed.revision
    }
    let snapshotText = selection.text
    if (
      (source.kind === 'project' || source.kind === 'literature') &&
      selection.locator.kind === 'calc' &&
      selection.locator.content_mode === 'reference'
    ) {
      try {
        const snapshot = await captureSelectionSnapshot(source, sourceRevision, selection)
        snapshotText = snapshot.snapshot_text
        sourceRevision = snapshot.source_revision
      } catch {
        setErrorKey('selectionActions.contextAddFailed')
        return
      }
    }
    const locator =
      selection.locator.kind === 'pdf'
        ? {
            ...selection.locator,
            text_shape_hash: await digestText(pdfSelectionShape(selection.text)),
          }
        : selection.locator
    const result = await ingress.addContext({
      kind: literature ? 'literature' : 'selection',
      source_id: literature ? source.literatureId : source.path,
      label: session.title + ' · 划词',
      selection_source_label: session.title,
      source_revision: sourceRevision,
      retention: 'next_turn',
      origin: 'explicit',
      anchor: {
        ...(literature ? { document_id: source.attachmentId } : {}),
        locator,
        selected_text_hash: await digestText(selection.text),
        preview_text: selection.text,
        snapshot_text: snapshotText,
      },
    })
    if (result.accepted_ref_ids.length) {
      ingress.openPanel('context_added')
      focusComposer()
    } else setErrorKey('selectionActions.contextAddFailed')
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
                  {w('selection.explain')}
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
                  icon={<Icon name="globe" size={14} />}
                  aria-pressed={activeAction === 'translate'}
                  onClick={() => {
                    if (activeAction !== 'translate') open('translate')
                  }}
                >
                  {w('selection.translate')}
                </Button>
              </>
            ),
          },
        ]
      : []),
    ...(resource || literature
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
                  {w('selection.add')}
                </Button>
              </>
            ),
          },
        ]
      : []),
  ]
    .filter((item) => React.Children.toArray(item.actions).length > 0)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  const toolbarActions = (
    <div className="contents [--vds-control-padding-sm:0_calc(var(--vds-space-1)*1.5)]">
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
              className="[--vds-divider-margin-vertical:0_var(--vds-space-1)]"
            />
          )}
        </React.Fragment>
      ))}
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
      data-ob="pdf-selection"
      className="vds-selection-actions min-h-[46px] w-max max-w-[calc(100vw-24px)]"
      style={{ left: position.left, top: position.top }}
      actions={toolbarActions}
    >
      {error && <p role="alert">{t(error)}</p>}
      {contributions.map((item) =>
        item.expanded ? <React.Fragment key={item.id}>{item.panel}</React.Fragment> : null
      )}
    </FloatingToolbar>
  )
}
