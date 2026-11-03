import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslation } from 'react-i18next'

import { IconButton, Input } from '../../components/ui'
import { Icon } from '../../icons'
import { useSelectionActionContribution, type SelectionReplacementRequest } from './actions'
import {
  useOfficeRuntime,
  type OfficePresentationState,
  type OfficeViewBinding,
  type OfficeSearchDirection,
  type OfficeSearchResult,
} from './office/runtime'
import {
  selectionFingerprint,
  useDocumentWorkspace,
  useWorkspaceController,
  type DocumentViewKind,
} from './workspace'
import { Preview } from './preview/Preview'
import { usesCsvDocument, usesOfficePreview } from './preview/routing'
import { CsvDocument } from './csv/Document'

const FAILURE_CODES = {
  unsupported: 'unsupported',
  selectionChanged: 'selection_changed',
} as const

const OFFICE_SEARCH_DELAY_MS = 180
const EMPTY_OFFICE_SEARCH: OfficeSearchResult = {
  ok: true,
  query: '',
  location: '',
  current: 0,
  total: 0,
}
const EMPTY_PRESENTATION_STATE: OfficePresentationState = {
  canNext: false,
  canPrevious: false,
  current: 0,
  total: 0,
}

export function OfficeSnapshot({ binding }: { binding: OfficeViewBinding }): React.JSX.Element {
  return usesCsvDocument(binding.title) ? (
    <CsvDocument bytes={binding.bytes} title={binding.title} revision={binding.revision} />
  ) : usesOfficePreview(binding.title, 'preview') ? (
    <Preview bytes={binding.bytes} title={binding.title} revision={binding.revision} />
  ) : (
    <OfficeRuntimeSnapshot binding={binding} />
  )
}

function OfficeRuntimeSnapshot({ binding }: { binding: OfficeViewBinding }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const runtime = useOfficeRuntime()
  const anchor = useCallback(
    (element: HTMLDivElement | null) => {
      runtime.registerAnchor(binding.viewId, element)
    },
    [binding.viewId, runtime]
  )

  useEffect(() => {
    runtime.registerView(binding.viewId, binding)
    return () => runtime.registerView(binding.viewId, null)
  }, [binding, runtime])

  return (
    <div
      className="vds-office-document relative grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)]"
      data-office-kind={binding.viewer}
      data-office-view="snapshot"
    >
      <div
        ref={anchor}
        className="vds-office-anchor grid min-h-0 min-w-0 place-items-center overflow-hidden bg-[var(--vds-bg-page)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
        data-office-anchor={binding.viewId}
      >
        {t('officeDocument.allocating')}
      </div>
    </div>
  )
}

export function OfficeDocument(props: {
  kind: 'office' | 'spreadsheet'
  sessionId: string
  tabId: string
  viewKind: DocumentViewKind
}): React.JSX.Element {
  const workspace = useDocumentWorkspace()
  const session = workspace.sessions[props.sessionId]
  return session && usesCsvDocument(session.source.path) ? (
    <CsvDocument
      bytes={session.bytes}
      title={session.source.path.split('/').pop() || session.title}
      revision={session.revision}
      sessionId={props.sessionId}
      tabId={props.tabId}
      viewKind={props.viewKind}
    />
  ) : session && usesOfficePreview(session.source.path, props.viewKind) ? (
    <Preview
      bytes={session.bytes}
      title={session.source.path.split('/').pop() || session.title}
      revision={session.revision}
      tabId={props.tabId}
    />
  ) : (
    <OfficeRuntimeDocument {...props} />
  )
}

function OfficeRuntimeDocument({
  kind,
  sessionId,
  tabId,
  viewKind,
}: {
  kind: 'office' | 'spreadsheet'
  sessionId: string
  tabId: string
  viewKind: DocumentViewKind
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const runtime = useOfficeRuntime()
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const session = workspace.sessions[sessionId]
  const canReplace = session?.selection?.locator.kind === 'writer'
  const isPresentation = /\.pptx?$/i.test(session?.source.path ?? '')
  const [presentationState, setPresentationState] = useState(EMPTY_PRESENTATION_STATE)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState(EMPTY_OFFICE_SEARCH)
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchQueryRef = useRef(searchQuery)
  const searchSequence = useRef(0)
  searchQueryRef.current = searchQuery
  const anchor = useCallback(
    (element: HTMLDivElement | null) => {
      runtime.registerAnchor(tabId, element)
    },
    [runtime, tabId]
  )
  const openSearch = useCallback((): void => {
    setSearchOpen(true)
  }, [])
  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
  }, [])
  const applySearchResult = useCallback((result: OfficeSearchResult): void => {
    if (result.query !== searchQueryRef.current) return
    setSearchResult(result)
    setSearching(false)
  }, [])
  const executeSearch = useCallback(
    async (query: string, direction: OfficeSearchDirection, showProgress = true): Promise<void> => {
      const sequence = ++searchSequence.current
      if (showProgress) setSearching(Boolean(query.trim()))
      const result = await runtime.searchOffice(tabId, query, direction)
      if (sequence !== searchSequence.current) return
      applySearchResult(result)
    },
    [applySearchResult, runtime, tabId]
  )

  useEffect(() => {
    runtime.registerOfficeSearch(tabId, {
      close: closeSearch,
      open: openSearch,
      update: applySearchResult,
    })
    return () => runtime.registerOfficeSearch(tabId, null)
  }, [applySearchResult, closeSearch, openSearch, runtime, tabId])

  useEffect(() => {
    runtime.setOfficeSearchVisible(tabId, searchOpen)
    return () => runtime.setOfficeSearchVisible(tabId, false)
  }, [runtime, searchOpen, tabId])

  useEffect(() => {
    setPresentationState(EMPTY_PRESENTATION_STATE)
    if (!isPresentation) return
    runtime.registerPresentationState(tabId, setPresentationState)
    return () => runtime.registerPresentationState(tabId, null)
  }, [isPresentation, runtime, session?.revision, tabId])

  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [searchOpen])

  useEffect(() => {
    if (!searchOpen) return
    if (!searchQuery.trim()) {
      setSearchResult({ ...EMPTY_OFFICE_SEARCH, query: searchQuery })
      setSearching(false)
      void executeSearch(searchQuery, 'first', false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void executeSearch(searchQuery, 'first')
    }, OFFICE_SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [executeSearch, searchOpen, searchQuery])

  const replacement = useMemo(
    () => ({
      actions: null,
      expanded: false,
      id: 'office-replacement',
      order: 300,
      replaceSelection:
        viewKind === 'edit' && canReplace
          ? async (request: SelectionReplacementRequest) => {
              const state = controller.getSnapshot()
              const tab = state.tabs[tabId]
              const session = tab ? state.sessions[tab.sessionId] : null
              if (
                !tab ||
                !session ||
                !session.capabilities.can_edit ||
                tab.viewKind !== 'edit' ||
                request.selection.locator.kind !== 'writer'
              ) {
                return { ok: false as const, error: FAILURE_CODES.unsupported }
              }
              if (
                session.id !== sessionId ||
                session.changeVersion !== request.expectedChangeVersion ||
                !session.selection ||
                selectionFingerprint(session.selection) !== request.expectedFingerprint
              )
                return { ok: false as const, error: FAILURE_CODES.selectionChanged }
              return runtime.replaceSelection(tabId, request)
            }
          : undefined,
    }),
    [canReplace, controller, runtime, sessionId, tabId, viewKind]
  )
  useSelectionActionContribution(tabId, replacement)

  const currentQueryHasResults =
    searchResult.ok && searchResult.query === searchQuery && searchResult.total > 0
  const searchStatus = !searchQuery.trim()
    ? ''
    : searching
      ? t('officeDocument.searching')
      : !searchResult.ok
        ? t('officeDocument.searchFailed')
        : currentQueryHasResults
          ? `${searchResult.current} / ${searchResult.total}`
          : t('officeDocument.notFound')
  const stepSearch = (direction: Extract<OfficeSearchDirection, 'next' | 'previous'>): void => {
    if (!currentQueryHasResults || searching) return
    void executeSearch(searchQuery, direction)
  }

  return (
    <div
      className={`vds-office-document relative grid h-full min-h-0 w-full ${isPresentation ? 'grid-rows-[minmax(0,1fr)_calc(var(--vds-space-10)+var(--vds-space-6))]' : 'grid-rows-[minmax(0,1fr)]'}`}
      data-shortcut-scope="office"
      data-office-kind={kind}
      data-office-presentation={isPresentation}
      data-office-session={sessionId}
      data-office-view={viewKind}
    >
      {searchOpen ? (
        <div
          aria-label={t('officeDocument.search')}
          className="vds-office-search"
          data-testid="office-search"
          role="search"
        >
          <div className="flex min-w-0 flex-1 items-center gap-[var(--vds-space-3)] [&>label]:flex-1">
            <span className="flex-none text-[var(--vds-text-tertiary)]" aria-hidden="true">
              <Icon name="search" size={20} sw={1.7} />
            </span>
            <Input
              ref={searchInputRef}
              aria-label={t('officeDocument.searchContent')}
              className="h-[var(--vds-control-height-lg)] border-0 bg-transparent px-0 text-[length:var(--vds-font-subhead)] text-[var(--vds-text-primary)] shadow-none outline-none placeholder:text-[var(--vds-text-placeholder)] hover:border-0 focus:outline-none focus-visible:border-0 focus-visible:outline-none focus-visible:shadow-none"
              data-testid="office-search-input"
              placeholder={t('officeDocument.fullSearch')}
              type="text"
              value={searchQuery}
              unstyled
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeSearch()
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  stepSearch(event.shiftKey ? 'previous' : 'next')
                }
              }}
            />
          </div>
          <span
            aria-live="polite"
            className="min-w-[var(--vds-office-search-status-min-width)] whitespace-nowrap text-center text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
            data-testid="office-search-status"
            role="status"
          >
            {searchStatus}
          </span>
          <div className="flex flex-none items-center gap-[var(--vds-space-2)]">
            <IconButton
              className="rounded-[var(--vds-radius-6)] text-[length:var(--vds-font-title)]"
              data-testid="office-search-previous"
              disabled={!currentQueryHasResults || searching}
              icon={
                <span className="text-[length:var(--vds-font-display-lv2)] font-[var(--vds-fw-light)] leading-none">
                  ↑
                </span>
              }
              label={t('officeDocument.previous')}
              size="lg"
              variant="outline"
              onClick={() => stepSearch('previous')}
            />
            <IconButton
              className="rounded-[var(--vds-radius-6)] text-[length:var(--vds-font-title)]"
              data-testid="office-search-next"
              disabled={!currentQueryHasResults || searching}
              icon={
                <span className="text-[length:var(--vds-font-display-lv2)] font-[var(--vds-fw-light)] leading-none">
                  ↓
                </span>
              }
              label={t('officeDocument.next')}
              size="lg"
              variant="outline"
              onClick={() => stepSearch('next')}
            />
            <IconButton
              className="rounded-[var(--vds-radius-6)]"
              label={t('officeDocument.closeSearch')}
              icon={<Icon name="close" size={18} sw={1.7} />}
              size="lg"
              variant="outline"
              onClick={closeSearch}
            />
          </div>
        </div>
      ) : null}
      <div
        ref={anchor}
        className="vds-office-anchor grid min-h-0 min-w-0 place-items-center overflow-hidden bg-[var(--vds-bg-page)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
        data-office-anchor={tabId}
      >
        {t('officeDocument.allocating')}
      </div>
      {isPresentation ? (
        <div
          aria-label={t('officeDocument.slideNavigation')}
          className="vds-office-presentation-controls flex min-w-0 items-center justify-center gap-[var(--vds-space-3)] bg-[var(--vds-bg-page)]"
          data-testid="office-presentation-controls"
          role="navigation"
        >
          <IconButton
            className="rounded-[var(--vds-radius-pill)]"
            data-testid="office-presentation-previous"
            disabled={!presentationState.canPrevious}
            icon={
              <span className="rotate-180">
                <Icon name="chevron-right" size={18} sw={1.8} />
              </span>
            }
            label={t('officeDocument.previousSlide')}
            size="lg"
            variant="outline"
            onClick={() => runtime.navigatePresentation(tabId, 'previous')}
          />
          <IconButton
            className="rounded-[var(--vds-radius-pill)]"
            data-testid="office-presentation-next"
            disabled={!presentationState.canNext}
            icon={<Icon name="chevron-right" size={18} sw={1.8} />}
            label={t('officeDocument.nextSlide')}
            size="lg"
            variant="outline"
            onClick={() => runtime.navigatePresentation(tabId, 'next')}
          />
        </div>
      ) : null}
    </div>
  )
}
