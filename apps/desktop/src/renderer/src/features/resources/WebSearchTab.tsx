import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight } from 'lucide-react'

import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
  EmptyState,
  Skeleton,
  Spinner,
  useToast
} from '../../components/ui'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { importWebResources, mutateResourceNode, webSearchSiteIconUrl } from './api'
import { WebImportDestination } from './Destination'
import { resourceErrorMessage } from './error'
import { SearchFeedback, type DestinationFailure } from './Feedback'
import {
  importFailureMessage,
  projectWebSearch,
  verifiedWebSearchCandidates,
  WEB_IMPORT_SELECTION_LIMIT,
  WEB_SEARCH_AUTOMATIC_ROUTE,
  webSearchModeDefinition,
  webSearchOutputMissing
} from './search'
import {
  WEB_SEARCH_CANDIDATES_MODE,
  webSearchNoticePending,
  withWebSearchNotice,
  type ResourceWebSearch,
  type WebSearchAttempt,
  type WebSearchNotice
} from './state'

const WEB_SOURCE_FALLBACK_MARK = 'W'
const WEB_SEARCH_SKELETON_COUNT = 3

function webSearchNoticeId(notice: WebSearchNotice, tabId: string): string {
  return `web-search-${notice}:${tabId}`
}

function sourceMark(source: string): string {
  const first = Array.from(source.trim())[0]
  return first ? first.toLocaleUpperCase() : WEB_SOURCE_FALLBACK_MARK
}

function latestAttempt(search: ResourceWebSearch | undefined): WebSearchAttempt | undefined {
  if (!search) return undefined
  if (search.resolvedMode) {
    return [...search.attempts].reverse().find((attempt) => (
      attempt.mode === search.resolvedMode && attempt.status === 'completed'
    ))
  }
  return search.attempts.at(-1)
}

function WebSearchLoading({ query }: { query: string }): React.JSX.Element {
  const { t } = useTranslation('resources')
  return (
    <section
      aria-busy="true"
      aria-label={t('webSearch.loading')}
      className="vds-web-search-loading grid gap-[var(--vds-space-3)]"
      data-testid="web-search-loading"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)] border-0 border-b border-solid border-[var(--vds-divider-default)] pb-[var(--vds-space-4)]">
        <div className="flex min-w-0 items-center gap-[var(--vds-space-3)]">
          <Spinner size="md" />
          <span className="flex min-w-0 items-baseline gap-[var(--vds-space-2)]">
            <span className="flex-none text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
              {t('webSearch.web')}
            </span>
            <strong className="truncate text-[length:var(--vds-font-subhead)] font-medium leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
              {t('webSearch.query', { query })}
            </strong>
          </span>
        </div>
        <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
          {t('webSearch.organizing')}
        </span>
      </div>

      <div className="grid gap-[var(--vds-space-3)]" aria-hidden="true">
        {Array.from({ length: WEB_SEARCH_SKELETON_COUNT }, (_, index) => (
          <Card
            data-testid={`web-search-loading-result-${index}`}
            key={index}
            padding="lg"
            variant="bordered"
          >
            <div className="flex items-start gap-[var(--vds-space-3)]">
              <Skeleton
                className="shrink-0"
                height="var(--vds-avatar-size-md)"
                width="var(--vds-avatar-size-md)"
              />
              <div className="grid min-w-0 flex-1 gap-[var(--vds-space-2)]">
                <span className="block w-2/5"><Skeleton /></span>
                <span className="block w-4/5"><Skeleton /></span>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  )
}

export function WebSearchTab({ tabId }: { tabId: string }): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('resources')
  const { toast } = useToast()
  const deliveredNotices = useRef(new Set<WebSearchNotice>())
  const search = state.resource.webSearches[tabId]
  const attempt = latestAttempt(search)
  const mode = attempt?.mode ?? WEB_SEARCH_AUTOMATIC_ROUTE[0]
  const modeDefinition = webSearchModeDefinition(mode)
  const projectId = state.tabs.find((tab) => tab.id === tabId)?.projectId
  const project = state.projects.find((candidate) => candidate.id === projectId)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importParent, setImportParent] = useState('')
  const [importParentPath, setImportParentPath] = useState('')
  const projection = useMemo(
    () => projectWebSearch(
      attempt?.invocationEvents ?? [],
      mode,
      attempt?.resultText,
      search?.query
    ),
    [attempt?.invocationEvents, attempt?.resultText, mode, search?.query]
  )
  const terminal = search?.status === 'completed'
    || search?.status === 'failed'
    || search?.status === 'interrupted'
    || search?.status === 'unknown'
  const missingSearchOutput = webSearchOutputMissing({
    invocationStarted: Boolean(attempt?.invocationId),
    terminal,
    executionEvidenceFound: projection.executionEvidenceFound,
    structuredOutputFound: projection.structuredOutputFound
  })
  const candidates = verifiedWebSearchCandidates(projection)
  const failed = search?.status === 'failed'
    || search?.status === 'interrupted'
    || search?.status === 'unknown'
    || (terminal && (Boolean(projection.error) || missingSearchOutput))
  const failureError = terminal
    ? search?.error
      || projection.error
      || (missingSearchOutput ? modeDefinition.executionError : undefined)
    : undefined
  const fallbackUsed = Boolean(search && search.attempts.length > 1)
  const fallbackReason = fallbackUsed ? search?.attempts[0]?.error : undefined

  const patchSearch = useCallback((patch: Partial<ResourceWebSearch>): void => {
    set((current) => {
      const existing = current.resource.webSearches[tabId]
      if (!existing) return current
      return {
        resource: {
          ...current.resource,
          webSearches: {
            ...current.resource.webSearches,
            [tabId]: { ...existing, ...patch }
          }
        }
      }
    })
  }, [set, tabId])

  const searching = Boolean(search) && !failed && !terminal

  /**
   * 一次性提示只在首次到达时投递。
   *
   * `search.notified` 跨挂载记账：切换标签会卸载本组件，回写到搜索状态后切回来不再重复弹；
   * `deliveredNotices` 只在本次挂载内闭锁，覆盖状态回写还没提交完的那一小段窗口。
   */
  const deliverNotice = useCallback((notice: WebSearchNotice, deliver: () => void): void => {
    if (!search || !webSearchNoticePending(search, notice)) return
    if (deliveredNotices.current.has(notice)) return
    deliveredNotices.current.add(notice)
    set((current) => {
      const existing = current.resource.webSearches[tabId]
      if (!existing) return current
      const next = withWebSearchNotice(existing, notice)
      if (next === existing) return current
      return {
        resource: {
          ...current.resource,
          webSearches: { ...current.resource.webSearches, [tabId]: next }
        }
      }
    })
    deliver()
  }, [search, set, tabId])

  useEffect(() => {
    if (!search || !terminal) return
    const toastId = webSearchNoticeId('result', tabId)
    deliverNotice('result', () => {
      if (failed) {
        toast({
          description: <SearchFeedback message={{ kind: 'failure', error: failureError }} />,
          id: toastId,
          title: <SearchFeedback message={{ kind: 'label', messageKey: failureError === modeDefinition.executionError
            ? modeDefinition.failureTitleKey
            : 'webFeedback.failed' }} />,
          tone: 'error'
        })
        return
      }
      toast({
        description: <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.candidates', total: candidates.length }} />,
        id: toastId,
        title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.completed' }} />,
        tone: 'success'
      })
    })
  }, [candidates.length, deliverNotice, failureError, failed, modeDefinition.executionError, modeDefinition.failureTitleKey, search, tabId, terminal, toast])

  useEffect(() => {
    if (!search || !fallbackUsed || mode === WEB_SEARCH_CANDIDATES_MODE) return
    deliverNotice('fallback', () => {
      toast({
        description: <SearchFeedback message={{ kind: 'fallback', error: fallbackReason }} />,
        id: webSearchNoticeId('fallback', tabId),
        title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.browser' }} />,
        tone: 'warning'
      })
    })
  }, [deliverNotice, fallbackReason, fallbackUsed, mode, search, tabId, toast])

  useEffect(() => {
    setImportDialogOpen(false)
    setImportParent('')
    setImportParentPath('')
  }, [project?.id])

  if (!search) {
    return (
      <EmptyState
        className="vds-web-search-empty"
        icon={<Icon name="globe" size={24} />}
        title={t('webSearch.expired')}
        description={t('webSearch.restart')}
      />
    )
  }

  const selected = new Set(search.selectedUrls)
  const eligibleCandidates = candidates.filter(
    (candidate) => search.importResults[candidate.url]?.status !== 'success'
  )
  const selectedCandidates = eligibleCandidates.filter((candidate) => selected.has(candidate.url))
  const allSelected = eligibleCandidates.length > 0
    && eligibleCandidates.every((candidate) => selected.has(candidate.url))
  const notifySelectionLimit = (): void => {
    toast({
      description: <SearchFeedback message={{ kind: 'limit', limit: WEB_IMPORT_SELECTION_LIMIT }} />,
      title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.selectionLimitTitle' }} />,
      tone: 'warning'
    })
  }

  const selectCandidate = (url: string, checked: boolean): void => {
    if (checked && !selected.has(url) && selectedCandidates.length >= WEB_IMPORT_SELECTION_LIMIT) {
      notifySelectionLimit()
      return
    }
    const next = new Set(search.selectedUrls)
    if (checked) next.add(url)
    else next.delete(url)
    patchSearch({ selectedUrls: [...next] })
  }

  const selectAll = (checked: boolean): void => {
    if (!checked) {
      patchSearch({ selectedUrls: [] })
      return
    }
    patchSearch({
      selectedUrls: eligibleCandidates
        .slice(0, WEB_IMPORT_SELECTION_LIMIT)
        .map((candidate) => candidate.url)
    })
    if (eligibleCandidates.length > WEB_IMPORT_SELECTION_LIMIT) notifySelectionLimit()
  }

  const openImportDialog = (): void => {
    setImportDialogOpen(true)
  }

  const createImportFolder = async (name: string): Promise<DestinationFailure | undefined> => {
    if (!project || search.importing) return { key: 'webFeedback.projectUnavailable' }
    const result = await mutateResourceNode(
      'create_folder',
      { parent: importParentPath, name },
      project.id
    )
    if (!result.ok || !result.node) {
      return resourceErrorMessage(result.error)
    }
    const parent = importParent ? `${importParent}/${result.node.name}` : result.node.name
    setImportParent(parent)
    setImportParentPath(result.node.path)
    await act.reloadResourceTree()
    return undefined
  }

  const saveSelected = async (parent: string): Promise<void> => {
    if (!project || selectedCandidates.length === 0 || search.importing) return
    if (selectedCandidates.length > WEB_IMPORT_SELECTION_LIMIT) {
      notifySelectionLimit()
      return
    }
    patchSearch({ importing: true })
    const result = await importWebResources(
      project.id,
      search.query,
      selectedCandidates.map((candidate) => ({
        title: candidate.title,
        url: candidate.url,
        snippet: candidate.description
      })),
      parent
    )
    if (!result.ok) {
      patchSearch({ importing: false })
      toast({
        description: <SearchFeedback message={{ kind: 'importFailure', error: result.error }} />,
        title: <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.requestFailed' }} />,
        tone: 'error'
      })
      return
    }
    const nextResults = { ...search.importResults }
    for (const item of result.items) {
      nextResults[item.url] = {
        status: item.status,
        error: item.error,
        nodePath: item.node?.path
      }
    }
    patchSearch({
      importing: false,
      importResults: nextResults,
      selectedUrls: result.items
        .filter((item) => item.status === 'failed')
        .map((item) => item.url)
    })
    setImportDialogOpen(false)
    if (result.succeeded > 0) await act.reloadResourceTree()
    toast({
      description: result.failed > 0
        ? <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.partial', total: result.failed }} />
        : <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.savedDescription' }} />,
      title: result.succeeded > 0
        ? <SearchFeedback message={{ kind: 'count', messageKey: 'webFeedback.saved', total: result.succeeded }} />
        : <SearchFeedback message={{ kind: 'label', messageKey: 'webFeedback.saveFailed' }} />,
      tone: result.failed > 0 ? 'warning' : 'success'
    })
  }

  return (
    <div className="vds-web-search" data-testid="web-search-tab">
      {searching ? (
        <WebSearchLoading query={search.query} />
      ) : null}

      {!project && candidates.length > 0 ? (
        <Alert
          data-testid="web-search-project-required"
          tone="warning"
          title={t('webSearch.projectRequired')}
          description={t('webSearch.projectHint')}
        />
      ) : null}

      {!searching ? (
        <section className="vds-web-search-results" aria-label={t('webSearch.candidates')}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)] border-0 border-b border-solid border-[var(--vds-divider-default)] pb-[var(--vds-space-4)]">
            <div className="flex min-w-0 items-center gap-[var(--vds-space-3)]">
              <Checkbox
                aria-label={t('webSearch.selectAll')}
                checked={allSelected}
                disabled={search.importing || eligibleCandidates.length === 0}
                onCheckedChange={selectAll}
              />
              <h1 className="m-0 text-[length:var(--vds-font-subhead)] font-medium leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                {t('webSearch.results')}
              </h1>
              <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
                {t('webSearch.total', { total: candidates.length })}
              </span>
            </div>
            {candidates.length > 0 ? (
              <div className="flex min-w-0 items-center gap-[var(--vds-space-3)]">
                <Button
                  data-testid="web-search-save"
                  disabled={!project || selectedCandidates.length === 0}
                  loading={search.importing}
                  onClick={openImportDialog}
                >
                  {t('webSearch.importSelected')}
                </Button>
              </div>
            ) : null}
          </div>
          {candidates.length > 0 ? (
            <div data-testid="web-search-results">
              {candidates.map((candidate, index) => {
                const importResult = search.importResults[candidate.url]
                const saved = importResult?.status === 'success'
                return (
                  <article
                    className="grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-[var(--vds-space-3)] border-0 border-b border-solid border-[var(--vds-divider-default)] py-[var(--vds-space-5)] last:border-b-0"
                    data-testid={`web-search-result-${index}`}
                    key={candidate.url}
                  >
                    <Checkbox
                      aria-label={t('webSearch.select', { title: candidate.title })}
                      checked={selected.has(candidate.url)}
                      className="mt-[var(--vds-space-1)]"
                      disabled={search.importing || saved}
                      onCheckedChange={(checked) => selectCandidate(candidate.url, checked)}
                    />
                    <Avatar
                      aria-hidden="true"
                      className="![border-radius:var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] shadow-[var(--vds-shadow-xs)]"
                      fallback={sourceMark(candidate.source)}
                      image={webSearchSiteIconUrl(candidate.url)}
                      size="lg"
                    />
                    <div className="grid min-w-0 gap-[var(--vds-space-2)]">
                      <CardTitle className="min-w-0" title={candidate.title}>
                        <Button
                          aria-label={t('webSearch.open', { title: candidate.title })}
                          className="inline-flex min-w-0 cursor-pointer items-center justify-start gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] border-0 bg-transparent p-0 text-left [font:inherit] text-[inherit] hover:underline focus-visible:shadow-[var(--vds-focus-brand)]"
                          data-testid={`web-search-result-title-${index}`}
                          onClick={() => void window.scholarseed.openExternal(candidate.url)}
                          unstyled
                        >
                          <span className="truncate">{candidate.title}</span>
                          <ArrowUpRight
                            aria-hidden="true"
                            className="shrink-0"
                            size={16}
                            strokeWidth={1.8}
                          />
                        </Button>
                      </CardTitle>
                      <p className="m-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
                        {candidate.description}
                      </p>
                      {importResult ? (
                        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                          <Badge tone={saved ? 'success' : 'danger'} size="sm">
                            {saved ? t('webSearch.saved') : t('webSearch.saveFailed')}
                          </Badge>
                          {!saved ? (
                            <span className="truncate text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
                              {importFailureMessage(t, importResult.error)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : failed ? (
            <div className="vds-web-search-waiting">{t('webSearch.retry')}</div>
          ) : (
            <EmptyState
              data-testid="web-search-no-results"
              icon={<Icon name="search" size={24} />}
              title={t('webSearch.empty')}
              description={projection.structuredOutputFound
                  ? t('webSearch.noCandidates')
                  : t('webSearch.invalidOutput')}
            />
          )}
        </section>
      ) : null}

      <WebImportDestination
        busy={search.importing}
        onConfirm={() => void saveSelected(importParent)}
        onCreateFolder={createImportFolder}
        onExpandFolder={(path) => void act.ensureResourceChildren(path)}
        onOpenChange={setImportDialogOpen}
        onSelect={(parent, nodePath) => {
          setImportParent(parent)
          setImportParentPath(nodePath)
        }}
        open={importDialogOpen}
        projectName={project?.name ?? t('webSearch.currentProject')}
        selectedCount={selectedCandidates.length}
        selectedParent={importParent}
        tree={state.resource.tree}
      />
    </div>
  )
}
