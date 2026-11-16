import {
  BookOpenText,
  ChevronRight,
  File,
  Folder,
  Layers2,
  ListTree,
  MailQuestionMark,
  Search,
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
import { FileFormatIcon } from '../primitive'
import { LIBRARY_TABLE_CLASS } from './Library'
import { fetchResourceListing } from '../../features/resources/api'
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
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  ScrollArea,
} from '../ui'

const REFERENCE_PAGE_SIZE = 10
const REFERENCE_SELECT_ALL_KEY = 'a'

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
  onCancel,
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
  onCancel?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: layoutText } = useTranslation('layout')
  const modal = Boolean(onCancel)
  const immediate = sourceId === 'session'
  const firstTaskRef = React.useRef<HTMLButtonElement>(null)
  const taskSearchRef = React.useRef<HTMLInputElement>(null)
  const taskFocused = React.useRef(false)
  const ListContainer = modal ? ScrollArea : 'div'
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => new Set())
  const [folderPages, setFolderPages] = React.useState<Map<string, AssistantContextCandidate[]>>(
    () => new Map()
  )
  const [loadingFolders, setLoadingFolders] = React.useState<Set<string>>(() => new Set())
  const [failedFolders, setFailedFolders] = React.useState<Set<string>>(() => new Set())
  const toggleFolder = async (item: AssistantContextCandidate): Promise<void> => {
    const id = item.source_id
    if (loadingFolders.has(id)) return
    if (expandedFolders.has(id) && !failedFolders.has(id)) {
      setExpandedFolders((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      return
    }
    setExpandedFolders((current) => new Set(current).add(id))
    if (folderPages.has(id)) return
    setLoadingFolders((current) => new Set(current).add(id))
    setFailedFolders((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    const items: AssistantContextCandidate[] = []
    let offset: number | null = 0
    const visited = new Set<number>()
    while (offset !== null && !visited.has(offset)) {
      visited.add(offset)
      const page = await fetchResourceCandidatePage(projectId, id, offset)
      if (!page) {
        setFailedFolders((current) => new Set(current).add(id))
        break
      }
      items.push(...page.items)
      offset = page.nextOffset
    }
    if (offset === null) setFolderPages((current) => new Map(current).set(id, items))
    setLoadingFolders((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }
  const [resourceRows, setResourceRows] = React.useState<
    NonNullable<Awaited<ReturnType<typeof fetchResourceListing>>>
  >([])
  React.useEffect(() => {
    if (!modal || sourceId !== RESOURCE_CONTEXT_KIND || !projectId) return
    let active = true
    void fetchResourceListing(projectId).then((rows) => {
      if (active) setResourceRows(rows ?? [])
    })
    return () => {
      active = false
    }
  }, [modal, sourceId, projectId])
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
  const toggleSelection = (
    current: Map<string, AssistantContextCandidate>,
    item: AssistantContextCandidate
  ): Map<string, AssistantContextCandidate> => {
    const key = `${item.kind}:${item.source_id}`
    const next = new Map(current)
    if (modal && sourceId === RESOURCE_CONTEXT_KIND) {
      const included = [...current.values()].some(
        (candidate) =>
          candidate.source_id === item.source_id ||
          (candidate.kind === 'dir' && item.source_id.startsWith(candidate.source_id + '/'))
      )
      for (const [id, candidate] of next) {
        if (
          candidate.source_id === item.source_id ||
          candidate.source_id.startsWith(item.source_id + '/')
        )
          next.delete(id)
      }
      if (!included) next.set(key, item)
      else {
        // A directory reference covers descendants. Split its scope only when a child is deselected.
        for (const [id, ancestor] of current) {
          if (ancestor.kind !== 'dir' || !item.source_id.startsWith(ancestor.source_id + '/'))
            continue
          next.delete(id)
          const remaining = resourceRows.filter(
            (node) =>
              node.path.startsWith(ancestor.source_id + '/') &&
              node.path !== item.source_id &&
              !node.path.startsWith(item.source_id + '/') &&
              !item.source_id.startsWith(node.path + '/')
          )
          for (const node of remaining) {
            if (
              remaining.some(
                (parent) => parent.kind === 'dir' && node.path.startsWith(parent.path + '/')
              )
            )
              continue
            const kind = node.kind === 'dir' ? 'dir' : 'file'
            const candidate = candidates.find((candidate) => candidate.source_id === node.path) ??
              [...folderPages.values()]
                .flat()
                .find((candidate) => candidate.source_id === node.path) ?? {
                ...ancestor,
                kind,
                source_id: node.path,
                label: node.name,
                ...(kind === 'file' ? { project_id: projectId } : {}),
              }
            if (!candidate.unavailable_reason) next.set(`${kind}:${node.path}`, candidate)
          }
        }
      }
      return next
    }
    if (next.has(key)) next.delete(key)
    else next.set(key, item)
    return next
  }
  const toggle = (item: AssistantContextCandidate): void => {
    setSelected((current) => toggleSelection(current, item))
  }
  const searching = Boolean(query.trim())
  const checkedState = (
    item: AssistantContextCandidate,
    selection = selected
  ): boolean | 'mixed' => {
    if (!modal || sourceId !== RESOURCE_CONTEXT_KIND)
      return selection.has(`${item.kind}:${item.source_id}`)
    if (
      [...selection.values()].some(
        (candidate) =>
          candidate.source_id === item.source_id ||
          (candidate.kind === 'dir' && item.source_id.startsWith(candidate.source_id + '/'))
      )
    )
      return true
    return item.kind === 'dir' &&
      [...selection.values()].some((candidate) =>
        candidate.source_id.startsWith(item.source_id + '/')
      )
      ? 'mixed'
      : false
  }
  const selectedCount =
    modal && sourceId === RESOURCE_CONTEXT_KIND
      ? new Set(
          [
            ...resourceRows.map(
              (row) => ({ kind: row.kind, source_id: row.path }) as AssistantContextCandidate
            ),
            ...selected.values(),
          ]
            .filter((item) => checkedState(item) === true)
            .map((item) => item.source_id)
        ).size
      : selected.size
  const browsing = !modal && Boolean(browse) && !searching
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
  const visibleCandidates = immediate
    ? displayedCandidates
    : displayedCandidates.slice(0, visibleCount)
  const firstAvailableTask = visibleCandidates.find((candidate) => !candidate.unavailable_reason)
  React.useEffect(() => {
    if (!immediate || pending || taskFocused.current) return
    const frame = window.requestAnimationFrame(() => {
      if (!firstTaskRef.current) return
      firstTaskRef.current.focus()
      firstTaskRef.current.scrollIntoView({ block: 'nearest' })
      taskFocused.current = true
    })
    return () => window.cancelAnimationFrame(frame)
  }, [immediate, pending, firstAvailableTask])
  const tableRows: { item: AssistantContextCandidate; depth: number }[] = []
  const visitedFolders = new Set<string>()
  const appendRows = (items: AssistantContextCandidate[], depth: number): void => {
    for (const item of items) {
      tableRows.push({ item, depth })
      if (
        !searching &&
        item.kind === 'dir' &&
        expandedFolders.has(item.source_id) &&
        !visitedFolders.has(item.source_id)
      ) {
        visitedFolders.add(item.source_id)
        appendRows(folderPages.get(item.source_id) ?? [], depth + 1)
      }
    }
  }
  appendRows(displayedCandidates, 0)
  const selectableRows = tableRows
    .map(({ item }) => item)
    .filter((item) => !item.unavailable_reason)
  const allSelected =
    selectableRows.length > 0 && selectableRows.every((item) => checkedState(item) === true)
  const someSelected = selectableRows.some((item) => checkedState(item) !== false)
  const selectAll = (checked: boolean): void => {
    setSelected((current) => {
      let next = new Map(current)
      for (const item of selectableRows) {
        const state = checkedState(item, next)
        if (checked ? state !== true : state === true) next = toggleSelection(next, item)
        else if (!checked && state === 'mixed') {
          for (const [key, candidate] of next) {
            if (candidate.source_id.startsWith(item.source_id + '/')) next.delete(key)
          }
        }
      }
      return next
    })
  }
  const browseLabel = (nodeId: string): string =>
    nodeId === browse?.ungrouped.id
      ? renderFeedback(i18n, browse.ungrouped.label)
      : (browseNodes.find((node) => node.id === nodeId)?.label ?? '')
  const browseNodeRow = (nodeId: string, label: string, nested: boolean): React.JSX.Element => {
    const candidate = browseNodes.find((node) => node.id === nodeId)?.candidate
    return (
      <div className="flex min-w-0 items-center gap-[var(--vds-space-1)]" key={nodeId}>
        {candidate && (
          <Checkbox
            aria-label={assistantText('referencePicker.select', { name: label })}
            checked={selected.has(`${candidate.kind}:${candidate.source_id}`)}
            className="shrink-0"
            data-testid={`ai-context-select-${candidate.kind}-${candidate.source_id}`}
            disabled={Boolean(candidate.unavailable_reason)}
            onCheckedChange={() => toggle(candidate)}
          />
        )}
        <Button
          className={`!h-auto min-w-0 flex-1 justify-start gap-[var(--vds-space-2)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left ${nested ? 'pl-[var(--vds-space-5)]' : ''}`}
          data-testid={`reference-picker-group-${nodeId}`}
          icon={
            nodeId === browse?.ungrouped.id ? <MailQuestionMark size={15} /> : <Layers2 size={15} />
          }
          onClick={() => setBrowsePath([...browsePath, nodeId])}
          size="content"
          variant="ghost"
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <DropdownMenuArrow />
        </Button>
      </div>
    )
  }

  return (
    <div
      aria-busy={pending || submitting}
      className={
        modal
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'flex max-h-[var(--vds-reference-picker-max-height)] min-h-0 flex-col overflow-hidden'
      }
      data-testid="reference-picker"
      onKeyDown={(event) => {
        const editing =
          event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest('input, textarea') !== null)
        if (
          modal &&
          !immediate &&
          !editing &&
          !event.defaultPrevented &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === REFERENCE_SELECT_ALL_KEY
        ) {
          event.preventDefault()
          event.stopPropagation()
          if (!pending && !submitting) selectAll(true)
          return
        }
        if (
          !immediate ||
          event.target instanceof HTMLInputElement ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return
        if (event.key.length !== 1 && event.key !== 'Backspace') return
        event.preventDefault()
        event.stopPropagation()
        onQueryChange(event.key === 'Backspace' ? query.slice(0, -1) : query + event.key)
        taskSearchRef.current?.focus()
      }}
    >
      <div
        className={
          modal
            ? 'grid flex-none gap-[var(--vds-space-2)] pb-[var(--vds-space-4)]'
            : 'grid flex-none gap-[var(--vds-space-2)] border-b border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-2)] pb-[var(--vds-space-3)] pt-[var(--vds-space-2)]'
        }
      >
        <div
          className={
            modal
              ? 'relative ml-auto w-full max-w-[var(--vds-library-list-search-width)]'
              : 'relative'
          }
        >
          <SearchBox
            ref={taskSearchRef}
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
        {!modal && browse && browsePath.length > 0 && (
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
      <ListContainer
        {...(modal
          ? {
              overlay: true,
              viewportClassName: 'min-h-0 flex-1',
              viewportProps: { 'aria-label': sourceLabel },
            }
          : {})}
        className={
          modal
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] [&_[role=scrollbar]]:!top-[var(--vds-library-header-height)]'
            : immediate
              ? 'flex min-h-0 flex-col gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto p-[var(--vds-space-1)]'
              : 'flex min-h-0 basis-[var(--vds-reference-picker-list-height)] flex-col gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto px-[var(--vds-space-1)] pb-[var(--vds-space-1)] pt-[var(--vds-space-1)]'
        }
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
        {modal && !initialLoading && displayedCandidates.length > 0 ? (
          <Table
            className={`${LIBRARY_TABLE_CLASS} self-start min-w-[var(--vds-library-material-width)]`}
          >
            <TableHeader>
              <TableRow>
                <TableHead>
                  <div className="flex items-center gap-[var(--vds-space-2)]">
                    <Checkbox
                      aria-label={assistantText('referencePicker.selectAll')}
                      checked={allSelected ? true : someSelected ? 'mixed' : false}
                      disabled={pending || submitting || selectableRows.length === 0}
                      onCheckedChange={selectAll}
                      data-testid="reference-picker-select-all"
                    />
                    {layoutText('fileName')}
                  </div>
                </TableHead>
                <TableHead>{layoutText('fileType')}</TableHead>
                <TableHead>{layoutText('fileSource')}</TableHead>
                <TableHead>{layoutText('updatedAt')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableRows.map(({ item, depth }) => {
                const resource = resourceRows.find((row) => row.path === item.source_id)
                const updatedAt = resource?.updatedAt ?? item.updated_at
                const source = resource?.source
                const fileName = item.display_file_name ?? item.label
                const fileType = fileName.includes('.')
                  ? fileName.split('.').pop()?.toUpperCase()
                  : '—'
                return (
                  <TableRow key={`${item.kind}:${item.source_id}`} className="last:!border-b-0">
                    <TableCell>
                      <div
                        className="flex min-w-0 items-center gap-[var(--vds-space-2)] pl-[calc(var(--vds-library-tree-depth)*var(--vds-material-tree-indent))]"
                        style={{ '--vds-library-tree-depth': depth } as React.CSSProperties}
                      >
                        <Checkbox
                          aria-label={assistantText('referencePicker.select', {
                            name: candidateLabel(item, assistantText),
                          })}
                          checked={checkedState(item)}
                          disabled={submitting || Boolean(item.unavailable_reason)}
                          onCheckedChange={() => toggle(item)}
                          data-testid={`ai-context-select-${item.kind}-${item.source_id}`}
                        />
                        <Button
                          variant="ghost"
                          size="content"
                          className="min-w-0 flex-1 justify-start"
                          aria-expanded={
                            item.kind === 'dir' ? expandedFolders.has(item.source_id) : undefined
                          }
                          disabled={submitting || Boolean(item.unavailable_reason)}
                          data-testid={`ai-context-option-${item.kind}-${item.source_id}`}
                          onClick={() => {
                            if (item.kind === 'dir') {
                              void toggleFolder(item)
                            } else toggle(item)
                          }}
                          icon={
                            <span className="inline-flex shrink-0 items-center gap-[var(--vds-space-1)]">
                              {sourceId === RESOURCE_CONTEXT_KIND && (
                                <ChevronRight
                                  aria-hidden
                                  className={
                                    item.kind !== 'dir'
                                      ? 'invisible size-[var(--vds-icon-6)]'
                                      : `size-[var(--vds-icon-6)] ${expandedFolders.has(item.source_id) ? 'rotate-90' : ''}`
                                  }
                                />
                              )}
                              {(item.kind !== 'literature' || item.display_file_name) && (
                                <FileFormatIcon
                                  name={item.display_file_name ?? item.label}
                                  kind={item.kind === 'dir' ? 'dir' : 'file'}
                                />
                              )}
                            </span>
                          }
                        >
                          <EllipsisText
                            tooltip={
                              item.unavailable_reason
                                ? contextText(item.unavailable_reason)
                                : candidateLabel(item, assistantText)
                            }
                          >
                            {candidateLabel(item, assistantText)}
                          </EllipsisText>
                          {loadingFolders.has(item.source_id) && (
                            <span role="status">{t('composer.loadingProject')}</span>
                          )}
                          {failedFolders.has(item.source_id) && (
                            <span>{assistantText('contextOption.retry')}</span>
                          )}
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      {item.kind === 'dir'
                        ? layoutText('folderType')
                        : resource?.fileType || fileType || '—'}
                    </TableCell>
                    <TableCell>
                      {source === 'imported'
                        ? layoutText('sourceImported')
                        : source === 'created'
                          ? layoutText('sourceCreated')
                          : source === 'linked'
                            ? layoutText('linkedSource')
                            : '—'}
                    </TableCell>
                    <TableCell>{updatedAt ? format.date(updatedAt * 1000) : '—'}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : initialLoading ? (
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
              if (immediate)
                return (
                  <Button
                    key={`${item.kind}:${item.source_id}`}
                    ref={item === firstAvailableTask ? firstTaskRef : undefined}
                    data-testid={`ai-context-option-${item.kind}-${item.source_id}`}
                    role="menuitem"
                    variant="ghost"
                    size="content"
                    className="!h-auto w-full min-w-0 justify-start !whitespace-normal px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left focus:!bg-[var(--vds-bg-white-hover-transparent)] focus-visible:!outline-none focus-visible:!shadow-none"
                    disabled={submitting || Boolean(item.unavailable_reason)}
                    onClick={() => {
                      setSubmitting(true)
                      void onConfirm([item]).finally(() => setSubmitting(false))
                    }}
                  >
                    <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)]">
                      <span className="line-clamp-2 break-words text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)]">
                        {candidateLabel(item, assistantText)}
                      </span>
                      {metadata && (
                        <small className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                          {metadata}
                        </small>
                      )}
                    </span>
                  </Button>
                )
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
            icon={immediate ? <Search strokeWidth={1.5} /> : <SearchX size={18} />}
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
      </ListContainer>
      {!immediate && (
        <div
          className={
            modal
              ? 'flex flex-none items-center justify-between gap-[var(--vds-space-2)] pt-[var(--vds-space-4)]'
              : 'flex flex-none items-center justify-between gap-[var(--vds-space-2)] border-t border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]'
          }
        >
          <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--text-3)]">
            {assistantText('referencePicker.selected', { count: selectedCount })}
          </span>
          <div className="flex items-center gap-[var(--vds-space-2)]">
            {onCancel && (
              <Button variant="outline" disabled={submitting} onClick={onCancel}>
                {assistantText('referencePicker.cancel')}
              </Button>
            )}
            <Button
              data-testid="reference-picker-confirm"
              disabled={selected.size === 0 || submitting}
              onClick={() => {
                setSubmitting(true)
                void onConfirm([...selected.values()]).finally(() => setSubmitting(false))
              }}
              size={modal ? 'md' : 'sm'}
              variant="primary"
            >
              {modal
                ? assistantText('referencePicker.confirm')
                : assistantText('referencePicker.add')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
