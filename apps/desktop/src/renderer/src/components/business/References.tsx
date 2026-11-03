import {
  BookOpenText,
  File,
  Folder,
  Layers2,
  ListTree,
  MailQuestionMark,
  SearchX,
  X,
} from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { createFormatters } from '../../../../localization/format'
import type { AssistantContextCandidate } from '../../contracts/assistant'
import type { AssistantBrowseNode, AssistantSourceBrowse } from '../../contracts/features'
import { renderFeedback } from '../../contracts/feedback'
import { fetchResourceCandidatePage, RESOURCE_CONTEXT_KIND } from '../../features/assistant/api'
import { candidateLabel, useAssistantContextText } from '../../features/assistant/text'
import { Icon } from '../../icons'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Checkbox,
  DropdownMenuArrow,
  EllipsisText,
  EmptyState,
  IconButton,
  SearchBox,
  Tooltip,
} from '../ui'

const REFERENCE_PAGE_SIZE = 10

function TruncatedTitleTooltip({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}): React.JSX.Element {
  const rowRef = React.useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = React.useState(false)

  React.useLayoutEffect(() => {
    const row = rowRef.current
    const label = row?.querySelector<HTMLElement>('.line-clamp-2')
    if (!row || !label) return
    const update = (): void => setTruncated(label.scrollHeight > label.clientHeight + 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    observer.observe(label)
    return () => observer.disconnect()
  }, [title])

  return (
    <Tooltip className="!w-full" content={title} disabled={!truncated} portalled side="left">
      <span className="block w-full" ref={rowRef}>
        {children}
      </span>
    </Tooltip>
  )
}

export function ReferencePicker({
  browse,
  candidates,
  emptyLabel,
  loading,
  onQueryChange,
  onConfirm,
  projectId,
  query,
  sourceId,
  sourceLabel,
}: {
  browse?: AssistantSourceBrowse
  candidates: AssistantContextCandidate[]
  emptyLabel: React.ReactNode
  loading: boolean
  onQueryChange: (query: string) => void
  onConfirm: (candidates: AssistantContextCandidate[]) => Promise<void>
  projectId: string | null
  query: string
  sourceId: string
  sourceLabel: string
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText, i18n } = useTranslation('assistant')
  const contextText = useAssistantContextText()
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const [selected, setSelected] = React.useState<Map<string, AssistantContextCandidate>>(
    () => new Map()
  )
  const [path, setPath] = React.useState<AssistantContextCandidate[]>([])
  const [folderCandidates, setFolderCandidates] = React.useState<AssistantContextCandidate[]>([])
  const [nextOffset, setNextOffset] = React.useState<number | null>(null)
  const [folderLoading, setFolderLoading] = React.useState(false)
  const [folderFailed, setFolderFailed] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [browseNodes, setBrowseNodes] = React.useState<AssistantBrowseNode[]>([])
  const [browseNodesLoading, setBrowseNodesLoading] = React.useState(Boolean(browse))
  const [browseNodesFailed, setBrowseNodesFailed] = React.useState(false)
  const [browsePath, setBrowsePath] = React.useState<string[]>([])
  const [browseCandidates, setBrowseCandidates] = React.useState<AssistantContextCandidate[]>([])
  const [browseCandidatesNodeId, setBrowseCandidatesNodeId] = React.useState<string | null>(null)
  const [browseCandidatesLoading, setBrowseCandidatesLoading] = React.useState(false)
  const [browseCandidatesFailed, setBrowseCandidatesFailed] = React.useState(false)
  const [browseReload, setBrowseReload] = React.useState(0)
  const activeBrowseNodeId = browsePath.at(-1) ?? null
  const browseNodesRequestId = React.useRef(0)
  const browseItemsRequestId = React.useRef(0)
  React.useEffect(() => {
    setBrowsePath([])
  }, [browse, projectId])
  React.useEffect(() => {
    if (!browse) return
    const currentRequest = ++browseNodesRequestId.current
    setBrowseNodesLoading(true)
    setBrowseNodesFailed(false)
    void browse
      .nodes(projectId)
      .catch(() => null)
      .then((nodes) => {
        if (currentRequest !== browseNodesRequestId.current) return
        setBrowseNodesLoading(false)
        if (!nodes) {
          setBrowseNodesFailed(true)
          return
        }
        setBrowseNodes(nodes)
      })
    return () => {
      browseNodesRequestId.current += 1
    }
  }, [browse, projectId, browseReload])
  React.useEffect(() => {
    if (!browse || !activeBrowseNodeId) return
    const currentRequest = ++browseItemsRequestId.current
    setBrowseCandidatesLoading(true)
    setBrowseCandidatesFailed(false)
    void browse
      .items(projectId, activeBrowseNodeId)
      .catch(() => null)
      .then((items) => {
        if (currentRequest !== browseItemsRequestId.current) return
        setBrowseCandidatesLoading(false)
        if (!items) {
          setBrowseCandidatesFailed(true)
          return
        }
        setBrowseCandidates(items)
        setBrowseCandidatesNodeId(activeBrowseNodeId)
      })
    return () => {
      browseItemsRequestId.current += 1
    }
  }, [activeBrowseNodeId, browse, projectId, browseReload])
  const folder = path.at(-1)
  const requestId = React.useRef(0)
  React.useEffect(() => {
    if (!folder) return
    const currentRequest = ++requestId.current
    setFolderLoading(true)
    setFolderFailed(false)
    setFolderCandidates([])
    setNextOffset(null)
    void fetchResourceCandidatePage(projectId, folder.source_id, 0).then((page) => {
      if (currentRequest !== requestId.current) return
      setFolderLoading(false)
      if (!page) {
        setFolderFailed(true)
        return
      }
      setFolderCandidates(page.items)
      setNextOffset(page.nextOffset)
    })
    return () => {
      requestId.current += 1
    }
  }, [folder, projectId])
  const toggle = (item: AssistantContextCandidate): void => {
    const key = `${item.kind}:${item.source_id}`
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, item)
      return next
    })
  }
  const searching = Boolean(query.trim())
  const browsing = Boolean(browse) && !searching
  const childBrowseNodes = browsing
    ? browseNodes.filter((node) => node.parentId === activeBrowseNodeId)
    : []
  const displayedCandidates = browsing
    ? activeBrowseNodeId && browseCandidatesNodeId === activeBrowseNodeId
      ? browseCandidates
      : []
    : folder
      ? folderCandidates.filter((item) =>
          candidateLabel(item, assistantText).toLowerCase().includes(query.trim().toLowerCase())
        )
      : candidates
  const pending = browsing
    ? activeBrowseNodeId
      ? browseCandidatesLoading
      : browseNodesLoading
    : folder
      ? folderLoading
      : loading
  const browseFailed = browsing && (activeBrowseNodeId ? browseCandidatesFailed : browseNodesFailed)
  const noMatch = Boolean(query.trim()) && !pending && displayedCandidates.length === 0
  const initialLoading =
    pending && displayedCandidates.length === 0 && childBrowseNodes.length === 0
  const [visibleCount, setVisibleCount] = React.useState(REFERENCE_PAGE_SIZE)
  React.useEffect(() => {
    setVisibleCount(REFERENCE_PAGE_SIZE)
  }, [browseCandidates, candidates, folderCandidates, query])
  const visibleCandidates = displayedCandidates.slice(0, visibleCount)
  const browseLabel = (nodeId: string): string =>
    nodeId === browse?.ungrouped.id
      ? renderFeedback(i18n, browse.ungrouped.label)
      : (browseNodes.find((node) => node.id === nodeId)?.label ?? '')
  const browseNodeRow = (nodeId: string, label: string, nested: boolean): React.JSX.Element => (
    <Button
      className={`!h-auto w-full justify-start gap-[var(--vds-space-2)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left ${nested ? 'pl-[var(--vds-space-5)]' : ''}`}
      data-testid={`reference-picker-group-${nodeId}`}
      icon={
        nodeId === browse?.ungrouped.id ? <MailQuestionMark size={15} /> : <Layers2 size={15} />
      }
      key={nodeId}
      onClick={() => setBrowsePath([...browsePath, nodeId])}
      size="content"
      variant="ghost"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <DropdownMenuArrow />
    </Button>
  )

  return (
    <div
      aria-busy={pending || submitting}
      className="flex max-h-[var(--vds-reference-picker-max-height)] min-h-0 flex-col overflow-hidden"
      data-testid="reference-picker"
    >
      <div className="grid flex-none gap-[var(--vds-space-2)] border-b border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-2)] pb-[var(--vds-space-3)] pt-[var(--vds-space-2)]">
        <div className="relative">
          <SearchBox
            aria-label={t('composer.searchSource', { source: sourceLabel })}
            data-testid="reference-picker-search"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('composer.searchSource', { source: sourceLabel })}
            size="sm"
            value={query}
          />
          {query && (
            <IconButton
              className="absolute right-[var(--vds-space-1)] top-1/2 -translate-y-1/2"
              data-testid="reference-picker-clear"
              icon={<X size={13} />}
              label={t('composer.clearSearch')}
              onClick={() => onQueryChange('')}
              size="xs"
              variant="ghost"
            />
          )}
        </div>
        {browse && browsePath.length > 0 && (
          <Breadcrumb className="min-w-0 overflow-hidden" data-testid="reference-picker-breadcrumb">
            <BreadcrumbList className="flex-nowrap overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <BreadcrumbItem>
                <BreadcrumbLink
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    setBrowsePath([])
                    onQueryChange('')
                  }}
                >
                  {sourceLabel}
                </BreadcrumbLink>
              </BreadcrumbItem>
              {(searching ? ['search'] : browsePath).map((nodeId, index) => (
                <React.Fragment key={nodeId}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {searching || index === browsePath.length - 1 ? (
                      <BreadcrumbPage>
                        {searching
                          ? assistantText('referencePicker.searchResults')
                          : browseLabel(nodeId)}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        href="#"
                        onClick={(event) => {
                          event.preventDefault()
                          setBrowsePath(browsePath.slice(0, index + 1))
                        }}
                      >
                        {browseLabel(nodeId)}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </React.Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}
        {!browsing && path.length > 0 && (
          <Breadcrumb className="min-w-0 overflow-hidden" data-testid="reference-picker-breadcrumb">
            <BreadcrumbList className="flex-nowrap overflow-hidden whitespace-nowrap">
              <BreadcrumbItem className="shrink-0">
                <BreadcrumbLink
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    setPath([])
                    onQueryChange('')
                  }}
                >
                  {sourceLabel}
                </BreadcrumbLink>
              </BreadcrumbItem>
              {path.map((segment, index) => {
                return (
                  <React.Fragment key={segment.source_id}>
                    <BreadcrumbSeparator className="shrink-0" />
                    <BreadcrumbItem className="min-w-0 shrink">
                      {index === path.length - 1 ? (
                        <BreadcrumbPage className="min-w-0">
                          <EllipsisText tooltipPortalled tooltipSide="bottom">
                            {segment.label}
                          </EllipsisText>
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          className="min-w-0"
                          href="#"
                          onClick={(event) => {
                            event.preventDefault()
                            setPath(path.slice(0, index + 1))
                            onQueryChange('')
                          }}
                        >
                          <EllipsisText tooltipPortalled tooltipSide="bottom">
                            {segment.label}
                          </EllipsisText>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </React.Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
        )}
      </div>
      <div
        className="flex min-h-0 basis-[var(--vds-reference-picker-list-height)] flex-col gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto px-[var(--vds-space-1)] pb-[var(--vds-space-1)] pt-[var(--vds-space-1)]"
        data-testid="reference-picker-list"
      >
        {browsing && !activeBrowseNodeId && browse && !browseNodesFailed && !browseNodesLoading && (
          <>
            <div
              className="flex items-center gap-[var(--vds-space-2)] px-[var(--vds-space-2)] pt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]"
              data-testid="reference-picker-categories-heading"
            >
              <ListTree size={15} />
              {renderFeedback(i18n, browse.heading)}
            </div>
            {childBrowseNodes.map((node) => browseNodeRow(node.id, node.label, true))}
            {browseNodeRow(
              browse.ungrouped.id,
              renderFeedback(i18n, browse.ungrouped.label),
              false
            )}
          </>
        )}
        {browsing &&
          activeBrowseNodeId &&
          childBrowseNodes.map((node) => browseNodeRow(node.id, node.label, false))}
        {browseFailed && (
          <Button onClick={() => setBrowseReload((value) => value + 1)} size="sm" variant="ghost">
            {assistantText('contextOption.retry')}
          </Button>
        )}
        {initialLoading ? (
          <div
            role="status"
            className="px-[var(--vds-space-3)] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)]"
          >
            {t('composer.loadingProject')}
          </div>
        ) : displayedCandidates.length ? (
          [
            ...visibleCandidates.map((item) => {
              const resourceMetadata =
                item.kind === 'dir'
                  ? assistantText('referencePicker.folderItems', { count: item.child_count ?? 0 })
                  : assistantText('referencePicker.file')
              const metadata = item.unavailable_reason
                ? contextText(item.unavailable_reason)
                : sourceId === RESOURCE_CONTEXT_KIND
                  ? resourceMetadata
                  : item.hint ||
                    (item.kind === 'session' && item.created_at
                      ? format.date(item.created_at * 1000, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })
                      : '')
              const firstLineAligned =
                item.kind === 'literature' ||
                item.kind === 'session' ||
                item.kind === 'dir' ||
                item.kind === 'file'
              const clampedTitle = firstLineAligned
              const candidateIcon =
                item.kind === 'dir' ? (
                  <Folder size={15} />
                ) : item.kind === 'literature' ? (
                  <BookOpenText size={15} />
                ) : item.kind === 'session' ? (
                  <Icon name="quote" size={15} />
                ) : (
                  <File size={15} />
                )
              const row = (
                <div
                  className={`flex min-w-0 ${firstLineAligned ? 'items-start' : 'items-center'} gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] pl-[calc(var(--vds-space-3)/2)] hover:bg-[var(--vds-bg-white-hover-transparent)]`}
                >
                  <span
                    className={
                      firstLineAligned
                        ? 'inline-flex h-[calc(var(--vds-space-2)+var(--vds-border-width-1)+var(--vds-lh-body-lv1))] shrink-0 items-end'
                        : 'inline-flex shrink-0'
                    }
                  >
                    <span
                      className={
                        firstLineAligned
                          ? 'inline-flex h-[var(--vds-lh-body-lv1)] items-center'
                          : 'inline-flex'
                      }
                    >
                      <Checkbox
                        aria-label={assistantText('referencePicker.select', {
                          name: candidateLabel(item, assistantText),
                        })}
                        checked={selected.has(`${item.kind}:${item.source_id}`)}
                        data-testid={`ai-context-select-${item.kind}-${item.source_id}`}
                        disabled={Boolean(item.unavailable_reason)}
                        onCheckedChange={() => toggle(item)}
                      />
                    </span>
                  </span>
                  <Button
                    className={`!h-auto min-h-[var(--vds-control-height-md)] w-full min-w-0 flex-1 ${firstLineAligned ? '!items-start' : ''} justify-start gap-[var(--vds-space-2)] !whitespace-normal px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left hover:!bg-transparent`}
                    data-testid={`ai-context-option-${item.kind}-${item.source_id}`}
                    disabled={Boolean(item.unavailable_reason)}
                    icon={
                      firstLineAligned ? (
                        <span className="inline-flex h-[var(--vds-lh-body-lv1)] shrink-0 items-center">
                          {candidateIcon}
                        </span>
                      ) : (
                        candidateIcon
                      )
                    }
                    onClick={() => {
                      if (item.kind === 'dir') {
                        setPath([...path, item])
                        onQueryChange('')
                      } else toggle(item)
                    }}
                    size="content"
                    variant="ghost"
                  >
                    <span className="grid min-w-0 flex-1 text-left">
                      <span
                        className={`${clampedTitle ? 'line-clamp-2' : 'whitespace-normal'} break-words ${sourceId === RESOURCE_CONTEXT_KIND ? 'text-[length:var(--vds-font-body-lv2)]' : 'text-[length:var(--vds-font-body-lv1)]'} font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)]`}
                      >
                        {candidateLabel(item, assistantText)}
                      </span>
                      {metadata && (
                        <small className="whitespace-normal break-words text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                          {metadata}
                        </small>
                      )}
                    </span>
                    {item.kind === 'dir' && (
                      <span className="inline-flex h-[var(--vds-lh-body-lv1)] items-center">
                        <DropdownMenuArrow />
                      </span>
                    )}
                  </Button>
                </div>
              )
              return clampedTitle ? (
                <TruncatedTitleTooltip
                  key={`${item.kind}:${item.source_id}`}
                  title={candidateLabel(item, assistantText)}
                >
                  {row}
                </TruncatedTitleTooltip>
              ) : (
                <React.Fragment key={`${item.kind}:${item.source_id}`}>{row}</React.Fragment>
              )
            }),
            displayedCandidates.length > visibleCandidates.length ? (
              <Button
                key="reference-picker-more"
                data-testid="reference-picker-more"
                className="flex w-full items-center justify-center border-0 px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)] hover:bg-[var(--vds-bg-white-hover)] hover:text-[var(--text)]"
                onClick={() => setVisibleCount((count) => count + REFERENCE_PAGE_SIZE)}
                size="content"
                variant="ghost"
              >
                {t('composer.viewMore')} ({displayedCandidates.length - visibleCandidates.length})
              </Button>
            ) : null,
          ]
        ) : !browsing || browseFailed || (activeBrowseNodeId && childBrowseNodes.length === 0) ? (
          <EmptyState
            variant="compact"
            className="min-h-[var(--vds-layout-search-row-max-height)] self-center"
            icon={<SearchX size={18} />}
            title={
              browseFailed || folderFailed
                ? assistantText('contextOption.retry')
                : noMatch
                  ? t('composer.noMatchingContent')
                  : browsing
                    ? assistantText(
                        activeBrowseNodeId === browse?.ungrouped.id
                          ? 'referencePicker.ungroupedEmpty'
                          : 'referencePicker.collectionEmpty'
                      )
                    : emptyLabel
            }
          />
        ) : null}
        {folder && !folderLoading && (folderFailed || nextOffset !== null) && (
          <Button
            className="hover:!bg-[var(--vds-bg-white-hover)]"
            onClick={() => {
              setFolderLoading(true)
              setFolderFailed(false)
              void fetchResourceCandidatePage(projectId, folder.source_id, nextOffset ?? 0).then(
                (page) => {
                  setFolderLoading(false)
                  if (!page) {
                    setFolderFailed(true)
                    return
                  }
                  setFolderCandidates((current) => [...current, ...page.items])
                  setNextOffset(page.nextOffset)
                }
              )
            }}
            size="sm"
            variant="ghost"
          >
            {assistantText(folderFailed ? 'contextOption.retry' : 'contextOption.more')}
          </Button>
        )}
      </div>
      <div className="flex flex-none items-center justify-between gap-[var(--vds-space-2)] border-t border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
        <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--text-3)]">
          {assistantText('referencePicker.selected', { count: selected.size })}
        </span>
        <Button
          data-testid="reference-picker-confirm"
          disabled={selected.size === 0 || submitting}
          onClick={() => {
            setSubmitting(true)
            void onConfirm([...selected.values()]).finally(() => setSubmitting(false))
          }}
          size="sm"
          variant="primary"
        >
          {assistantText('referencePicker.add')}
        </Button>
      </div>
    </div>
  )
}
