import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Folder, MessageCircle } from 'lucide-react'

import { getSessionFiles, getTaskFiles, type FilesResp, type ServeSession } from '../../api'
import {
  Button,
  EllipsisText,
  EmptyState,
  IconButton,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui'
import {
  LIBRARY_PAGE_CLASS,
  LIBRARY_HEADER_ACTION_CLASS,
  LIBRARY_TABLE_HEADER_CLASS,
  LibraryFilter,
  LibraryToolbar,
} from '../../components/business/Library'
import { libraryFileType, libraryUpdatedAt } from '../../components/business/utils'
import { FileFormatIcon } from '../../components/primitive'
import { absoluteSessionFilePath } from '../../components/markdown/links'
import { artifactIsDeliverable } from '../../model'
import { activeThread, selectedProject, useApp } from '../../store'
import { writeProjectEntryDrag } from '../../drag'
import { subscribeFileEvents } from '../project/events'
import { ArtifactEntry } from './Artifacts'
import { outputCategory } from './catalog'
import { createOutputSearch, searchOutputPages, type OutputPages } from './search'
import { OutputFileLink } from './Files'
import emptyImage from '../../assets/empty_img.webp'

type FileFilters = {
  query: string
  fileType: string
  stage: string
  sort: 'name' | 'updated'
  ascending: boolean
}
type DirectoryProps = {
  session: ServeSession
  project: string
  path: string
  depth: number
  revision: number
  cache: Map<string, FilesResp>
  filters: FileFilters
  rootPage?: FilesResp
  searchPages?: OutputPages
  expanded: Set<string>
  onExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
}
const OUTPUT_TABLE_CLASS =
  'w-full table-fixed [&_th]:sticky [&_th]:top-0 [&_th]:z-[var(--vds-z-sticky-header)] [&_th]:bg-[var(--vds-library-header-background)] [&_th]:text-[var(--vds-text-tertiary)] [&_td:not(:first-child)]:font-[var(--vds-fw-regular)] [&_tr]:border-[var(--vds-library-output-divider)] [&_th:first-child]:w-[var(--vds-library-output-name-column)]'

function OutputDirectory({
  session,
  project,
  path,
  depth,
  revision,
  cache,
  filters,
  rootPage,
  searchPages,
  expanded,
  onExpanded,
}: DirectoryProps): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const { state, act } = useApp()
  const key = session.session_id + ':' + path
  const [page, setPage] = useState(() => cache.get(key) ?? null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    if (searchPages) {
      setLoading(false)
      setFailed(false)
      return
    }
    const cached = rootPage ?? cache.get(key)
    if (!path && cached && !retry) {
      setPage(cached)
      setFailed(false)
      return
    }
    setLoading(true)
    setFailed(false)
    void getSessionFiles(session.session_id, path, undefined, 0, true).then((next) => {
      if (generation.current !== current) return
      if (next) {
        cache.set(key, next)
        setPage(next)
      }
      setFailed(!next)
      setLoading(false)
    })
    return () => {
      generation.current += 1
    }
  }, [
    session.session_id,
    path,
    revision,
    retry,
    cache,
    key,
    rootPage,
    searchPages,
    state.resource.tree,
  ])
  const more = async (): Promise<void> => {
    if (!page || loading) return
    const current = generation.current
    setLoading(true)
    const next = await getSessionFiles(session.session_id, path, undefined, page.items.length, true)
    if (generation.current !== current) return
    if (next) {
      const merged = { ...next, items: [...page.items, ...next.items] }
      cache.set(key, merged)
      setPage(merged)
    }
    setFailed(!next)
    setLoading(false)
  }
  const query = filters.query.trim().toLocaleLowerCase()
  const visiblePage = searchPages ? searchPages.get(key) : page
  const rows = (visiblePage?.items ?? [])
    .filter(
      (item) =>
        item.dir ||
        ((!query ||
          (path + '/' + item.name).toLocaleLowerCase().includes(query) ||
          session.title.toLocaleLowerCase().includes(query)) &&
          (!filters.fileType || libraryFileType(item.name) === filters.fileType) &&
          (!filters.stage ||
            (item.artifact ? outputCategory(item.artifact) : 'intermediate') === filters.stage))
    )
    .sort(
      (left, right) =>
        Number(right.dir) - Number(left.dir) ||
        (filters.ascending ? 1 : -1) *
          (filters.sort === 'name'
            ? left.name.localeCompare(right.name, i18n.language, { numeric: true })
            : (left.updated_at ?? 0) - (right.updated_at ?? 0))
    )
  return (
    <>
      {rows.map((item) => {
        const relative = [path, item.name].filter(Boolean).join('/')
        const open = Boolean(query) || expanded.has(session.session_id + ':' + relative)
        const artifact =
          item.artifact && artifactIsDeliverable(item.artifact) ? item.artifact : undefined
        const preview = (): void => {
          if (visiblePage)
            act.openFilePreview({
              path: relative,
              absolutePath: absoluteSessionFilePath(visiblePage.root, relative),
              sessionId: session.session_id,
              title: item.name,
              size: item.size,
            })
        }
        return (
          <React.Fragment key={relative}>
            <TableRow
              className="group/output"
              data-testid={artifact ? `output-${artifact.artifact_id}` : undefined}
              draggable={Boolean(visiblePage?.project_path)}
              onDragStart={(event) => {
                if (visiblePage?.project_path)
                  writeProjectEntryDrag(event.dataTransfer, project, {
                    path: visiblePage.project_path + '/' + relative,
                    name: item.name,
                    kind: item.dir ? 'dir' : 'file',
                  })
              }}
            >
              <TableCell>
                <div
                  style={{
                    paddingInlineStart: `calc(var(--vds-library-output-tree-offset) + var(--vds-library-tree-indent) * ${depth - 1})`,
                  }}
                >
                  {item.dir ? (
                    <Button
                      variant="ghost"
                      className="w-full !justify-start"
                      aria-expanded={open}
                      disabled={Boolean(query)}
                      onClick={() =>
                        onExpanded((previous) => {
                          const next = new Set(previous)
                          const directoryKey = session.session_id + ':' + relative
                          if (open) next.delete(directoryKey)
                          else next.add(directoryKey)
                          return next
                        })
                      }
                    >
                      {open ? <ChevronDown /> : <ChevronRight />}
                      <Folder />
                      <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
                        {item.name}
                      </EllipsisText>
                    </Button>
                  ) : (
                    <OutputFileLink
                      project={project}
                      projectPath={
                        visiblePage?.project_path
                          ? visiblePage.project_path + '/' + relative
                          : undefined
                      }
                      absolutePath={
                        visiblePage ? absoluteSessionFilePath(visiblePage.root, relative) : ''
                      }
                      className="!flex w-full min-w-0 !font-[var(--vds-fw-regular)] !text-[var(--vds-text-primary)] !no-underline"
                      sessionId={session.session_id}
                      path={relative}
                      onOpen={preview}
                    >
                      <span className="inline-flex w-full min-w-0 items-center gap-[var(--vds-space-2)] text-left">
                        <FileFormatIcon name={item.name} />
                        <EllipsisText
                          wrapperClassName="min-w-0 flex-1"
                          tooltip={relative}
                          tooltipPortalled
                        >
                          {item.name.split('/').at(-1)}
                        </EllipsisText>
                      </span>
                    </OutputFileLink>
                  )}
                </div>
              </TableCell>
              <TableCell>{item.dir ? t('folderType') : libraryFileType(item.name)}</TableCell>
              <TableCell>
                {item.dir ? '—' : t(artifact ? outputCategory(artifact) : 'intermediate')}
              </TableCell>
              <TableCell>
                {libraryUpdatedAt(
                  item.updated_at ?? undefined,
                  i18n.language,
                  Date.now(),
                  t('justNow')
                )}
              </TableCell>
              <TableCell>
                {artifact ? (
                  <ArtifactEntry
                    primary={artifact}
                    versions={[artifact]}
                    mode="actions"
                    context={{
                      sessionId: session.session_id,
                      workdir: visiblePage?.root,
                      projectPath: session.project_path,
                    }}
                  />
                ) : !item.dir && visiblePage ? (
                  <OutputFileLink
                    mode="actions"
                    project={project}
                    projectPath={
                      visiblePage.project_path
                        ? visiblePage.project_path + '/' + relative
                        : undefined
                    }
                    absolutePath={absoluteSessionFilePath(visiblePage.root, relative)}
                    sessionId={session.session_id}
                    path={relative}
                    onOpen={preview}
                  />
                ) : null}
              </TableCell>
            </TableRow>
            {item.dir && open && (
              <OutputDirectory
                session={session}
                project={project}
                path={relative}
                depth={depth + 1}
                revision={revision}
                cache={cache}
                filters={filters}
                searchPages={searchPages}
                expanded={expanded}
                onExpanded={onExpanded}
              />
            )}
          </React.Fragment>
        )
      })}
      {!path &&
        filters.stage !== 'final' &&
        (!filters.fileType || filters.fileType === 'PDF') &&
        visiblePage?.literature
          ?.filter(
            (document) =>
              !query ||
              session.title.toLocaleLowerCase().includes(query) ||
              document.title.toLocaleLowerCase().includes(query)
          )
          .map((document) => (
            <TableRow key={'literature:' + document.id}>
              <TableCell>
                <Button
                  variant="ghost"
                  className="w-full !justify-start"
                  disabled={!document.literature_id}
                  onClick={() =>
                    void act.openLiteratureAttachment(
                      document.literature_id,
                      document.attachment_id ?? undefined
                    )
                  }
                >
                  <FileFormatIcon name="document.pdf" />
                  <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
                    {document.title}
                  </EllipsisText>
                </Button>
              </TableCell>
              <TableCell>{libraryFileType('document.pdf')}</TableCell>
              <TableCell>{t('intermediate')}</TableCell>
              <TableCell>—</TableCell>
              <TableCell />
            </TableRow>
          ))}
      {!searchPages &&
        ((loading && !page) ||
          failed ||
          (page && !rows.length && !page.literature?.length) ||
          (page && page.items.length < (page.total ?? page.items.length))) && (
          <TableRow>
            <TableCell colSpan={5}>
              {loading && !page ? (
                <Spinner />
              ) : failed ? (
                <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                  {t('readFailed')}
                </Button>
              ) : !rows.length ? (
                t('emptyTaskDirectory')
              ) : null}
              {page && page.items.length < (page.total ?? page.items.length) && (
                <Button disabled={loading} onClick={() => void more()}>
                  {t('loadMore')}
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
    </>
  )
}

export function Outputs(): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('layout')
  const project = selectedProject(state)
  const projectId = project?.id
  const projectPath = project?.path
  const currentSession = activeThread(state).sessionId
  const [catalog, setCatalog] = useState<{ project: string; sessions: ServeSession[] } | null>(null)
  const refreshCatalog = useRef<(() => void) | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const [fileType, setFileType] = useState('')
  const [stage, setStage] = useState('')
  const [sort, setSort] = useState<'name' | 'updated'>('updated')
  const [ascending, setAscending] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(currentSession ? [currentSession] : [])
  )
  const cache = useRef(new Map<string, FilesResp>()).current
  const [directories, setDirectories] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState<{
    project: string
    pages: OutputPages
    failed: boolean
    complete: boolean
  } | null>(null)
  const searchLoader = useRef<ReturnType<typeof createOutputSearch> | null>(null)
  const searching = Boolean(query.trim())
  const searchReady = Boolean(projectId) && search?.project === projectId
  const searchingFiles = !failed && (!searchReady || !search?.complete)
  const result = useMemo(
    () =>
      searchReady && search && catalog
        ? searchOutputPages(
            catalog.sessions,
            search.pages,
            query,
            (item) =>
              (!fileType || libraryFileType(item.name) === fileType) &&
              (!stage || (item.artifact ? outputCategory(item.artifact) : 'intermediate') === stage)
          )
        : null,
    [searchReady, search, catalog, query, fileType, stage]
  )
  const sessions =
    catalog && catalog.project === projectId
      ? [...(result?.sessions ?? [])].sort(
          (left, right) =>
            (ascending ? 1 : -1) *
            (sort === 'name'
              ? left.title.localeCompare(right.title)
              : (left.mtime ?? 0) - (right.mtime ?? 0))
        )
      : []
  useEffect(() => {
    cache.clear()
    setLoading(true)
    setFailed(false)
    setQuery('')
    setFileType('')
    setStage('')
    setExpanded(new Set())
    setDirectories(new Set())
    setSearch(null)
  }, [projectId, cache])
  useEffect(() => {
    if (currentSession) setExpanded((previous) => new Set([...previous, currentSession]))
  }, [projectId, currentSession])
  useEffect(() => {
    let alive = true
    if (!projectId || !projectPath) {
      setLoading(false)
      return
    }
    let running = false
    let pending = false
    const run = async (): Promise<void> => {
      running = true
      try {
        while (pending && alive) {
          pending = false
          const entries: ServeSession[] = []
          const roots = new Map<string, FilesResp | null>()
          let cursor = ''
          try {
            do {
              const next = await getTaskFiles(projectPath, cursor)
              if (!alive) return
              if (!next) throw new Error('Task output catalog unavailable')
              for (const entry of next.entries) {
                entries.push(entry.session)
                roots.set(entry.session.session_id + ':', entry.files)
              }
              cursor = next.next_cursor ?? ''
            } while (cursor)
            for (const [key, files] of roots) {
              if (files) cache.set(key, files)
              else cache.delete(key)
            }
            setCatalog({ project: projectId, sessions: entries })
            setFailed(false)
          } catch {
            if (!alive) return
            setFailed(true)
          }
          setLoading(false)
        }
      } finally {
        running = false
      }
    }
    refreshCatalog.current = () => {
      pending = true
      if (!running) void run()
    }
    return () => {
      alive = false
      refreshCatalog.current = null
    }
  }, [projectId, projectPath, cache])
  useEffect(() => {
    refreshCatalog.current?.()
  }, [projectId, projectPath, revision, state.sessionCatalogRevision, state.resource.tree])
  useEffect(() => {
    if (!projectId) return
    setSearch(null)
    const loader = createOutputSearch(
      (session, path, offset) => getSessionFiles(session, path, undefined, offset, true),
      (loaded) => setSearch({ project: projectId, ...loaded })
    )
    searchLoader.current = loader
    return () => {
      loader.cancel()
      searchLoader.current = null
    }
  }, [projectId])
  useEffect(() => {
    if (!catalog || catalog.project !== projectId || loading) return
    searchLoader.current?.load(catalog.sessions, cache)
  }, [catalog, projectId, loading, cache])
  useEffect(() => {
    if (!projectId) return
    return subscribeFileEvents(projectId, () => setRevision((value) => value + 1))
  }, [projectId])
  const types = [
    ...new Set(
      [...(searchReady && search ? search.pages : cache).values()].flatMap((page) =>
        page.items.filter((item) => !item.dir).map((item) => libraryFileType(item.name))
      )
    ),
  ]
    .sort()
    .map((value) => ({ value, label: value }))
  const refresh = (): void => {
    setLoading(true)
    setRevision((value) => value + 1)
  }
  return (
    <section className={LIBRARY_PAGE_CLASS} data-testid="project-outputs">
      <LibraryToolbar
        searchVisible
        query={query}
        onQuery={setQuery}
        placeholder={t('searchTaskFiles')}
        refreshing={loading || searchingFiles}
        onRefresh={refresh}
      />
      <div
        className="min-h-0 flex-1 overflow-auto rounded-[var(--vds-radius-6)] border border-[var(--vds-library-output-border)]"
        tabIndex={0}
      >
        <Table
          density="compact"
          className={`${LIBRARY_TABLE_HEADER_CLASS} ${OUTPUT_TABLE_CLASS} min-w-[var(--vds-library-output-width)] [&_td]:overflow-hidden`}
        >
          <TableHeader>
            <TableRow>
              <TableHead
                className="!w-[var(--vds-library-output-name-column)]"
                aria-sort={sort === 'name' ? (ascending ? 'ascending' : 'descending') : 'none'}
              >
                <Button
                  variant="ghost"
                  className={`${LIBRARY_HEADER_ACTION_CLASS} w-full`}
                  onClick={() => {
                    setAscending(sort === 'name' ? !ascending : true)
                    setSort('name')
                  }}
                >
                  {t('fileName')}
                  {sort === 'name' && (ascending ? <ArrowUp /> : <ArrowDown />)}
                </Button>
              </TableHead>
              <TableHead className="!w-[var(--vds-library-output-type-column)]">
                <LibraryFilter
                  label={t('fileType')}
                  value={fileType}
                  options={types}
                  onChange={setFileType}
                />
              </TableHead>
              <TableHead className="!w-[var(--vds-library-output-stage-column)]">
                <LibraryFilter
                  label={t('outputStage')}
                  value={stage}
                  options={[
                    { value: 'final', label: t('final') },
                    { value: 'intermediate', label: t('intermediate') },
                  ]}
                  onChange={setStage}
                />
              </TableHead>
              <TableHead
                className="!w-[var(--vds-library-output-time-column)]"
                aria-sort={sort === 'updated' ? (ascending ? 'ascending' : 'descending') : 'none'}
              >
                <LibraryFilter
                  label={t('updatedAt')}
                  value={sort === 'updated' ? (ascending ? 'ascending' : 'descending') : ''}
                  includeAll={false}
                  options={[
                    { value: 'descending', label: t('timeDescending') },
                    { value: 'ascending', label: t('timeAscending') },
                  ]}
                  onChange={(value) => {
                    setSort('updated')
                    setAscending(value === 'ascending')
                  }}
                />
              </TableHead>
              <TableHead
                className="!w-[var(--vds-library-output-action-column)]"
                aria-label={t('explorerActions')}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!sessions.length && (searchingFiles || loading || failed) && (
              <TableRow>
                <TableCell colSpan={5}>
                  {loading || searchingFiles ? (
                    <Spinner />
                  ) : failed ? (
                    <Button variant="outline" onClick={refresh}>
                      {t('readFailed')}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            )}
            {sessions.map((session) => {
              const open = searching || expanded.has(session.session_id)
              return (
                <React.Fragment key={session.session_id}>
                  <TableRow data-testid={`output-group-${session.session_id}`}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-[var(--vds-space-1)]">
                        <IconButton
                          variant="ghost"
                          label={session.title}
                          aria-expanded={open}
                          disabled={searching}
                          icon={open ? <ChevronDown /> : <ChevronRight />}
                          onClick={() =>
                            setExpanded((previous) => {
                              const next = new Set(previous)
                              if (open) next.delete(session.session_id)
                              else next.add(session.session_id)
                              return next
                            })
                          }
                        />
                        <Button
                          variant="ghost"
                          className="min-w-0 flex-1 overflow-hidden !justify-start !px-[var(--vds-space-1)]"
                          onClick={() => void act.openSession(session.session_id)}
                        >
                          <MessageCircle />
                          <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
                            {session.title}
                          </EllipsisText>
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>{t('folderType')}</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell />
                  </TableRow>
                  {open && projectId && (
                    <OutputDirectory
                      session={session}
                      project={projectId}
                      path=""
                      depth={1}
                      revision={revision + state.sessionCatalogRevision}
                      cache={cache}
                      rootPage={cache.get(session.session_id + ':')}
                      filters={{ query, fileType, stage, sort, ascending }}
                      searchPages={result?.pages}
                      expanded={directories}
                      onExpanded={setDirectories}
                    />
                  )}
                </React.Fragment>
              )
            })}
          </TableBody>
        </Table>
        {!loading && !failed && !searchingFiles && !search?.failed && !sessions.length && (
          <EmptyState
            image={{ src: emptyImage, alt: '' }}
            title={t(searching || fileType || stage ? 'noMatchingOutputs' : 'emptyOutputs')}
          />
        )}
        {failed && sessions.length > 0 && (
          <Button variant="outline" onClick={refresh}>
            {t('readFailed')}
          </Button>
        )}
        {searchReady && search?.failed && (
          <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
            {t('outputSearchIncomplete')}
          </Button>
        )}
      </div>
    </section>
  )
}
