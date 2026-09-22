import { useTranslation } from 'react-i18next'
import React, { useMemo, useRef, useState } from 'react'

import {
  Input,
  IconButton,
  Alert,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogPortal,
  Pagination,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../../components/ui'
import { IconFont } from '../../components/primitive'
import { useApp } from '../../store'
import { LiteratureApiError, importBibliography, listLiteratureCollections, createLiteratureCollection, type LibraryCollection } from './api'
import { catalogue } from './catalog'
import { DestinationRows, MENU_BOUNDS } from './DestinationTree'
import { collectionNodes, type JoinDestination } from './join'
import { searchPapersBibtex } from './result'
import { literatureErrorMessage, type LiteratureErrorMessage } from './error'

const REFERENCES_PAGE_SIZE = 5
const REFERENCES_FULL_PAGE_LIMIT = 4
const VISIBLE_AUTHORS = 2

const LITERATURE_SCHEMA_VERSION = '1.0'
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

type Verification = 'verified' | 'unverified' | 'unverifiable-in-scope'

interface ReferenceItem {
  ref_id: string
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  cited_by: string[]
  claim: string | null
  verification: Verification
  evidence: string | null
  has_fulltext: boolean | null
  url: string | null
  doi: string | null
  arxiv_id: string | null
}

interface ReferencesContent {
  schema_version: string
  project: string
  references: ReferenceItem[]
}

const VERIFICATION: Record<Verification, { labelKey: 'references.verified' | 'references.unverified' | 'references.unverifiable'; tone: 'success' | 'warning' | 'neutral' }> = {
  verified: { labelKey: 'references.verified', tone: 'success' },
  unverified: { labelKey: 'references.unverified', tone: 'warning' },
  'unverifiable-in-scope': { labelKey: 'references.unverifiable', tone: 'neutral' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isReference(value: unknown): value is ReferenceItem {
  if (!isRecord(value)) return false
  return typeof value.ref_id === 'string'
    && typeof value.title === 'string'
    && Array.isArray(value.authors)
    && value.authors.every((author) => typeof author === 'string')
    && (value.year === null || typeof value.year === 'number')
    && optionalString(value.venue)
    && Array.isArray(value.cited_by)
    && value.cited_by.every((citation) => typeof citation === 'string')
    && optionalString(value.claim)
    && (value.verification === 'verified'
      || value.verification === 'unverified'
      || value.verification === 'unverifiable-in-scope')
    && optionalString(value.evidence)
    && (value.has_fulltext === null || typeof value.has_fulltext === 'boolean')
    && optionalString(value.url)
    && optionalString(value.doi)
    && optionalString(value.arxiv_id)
}

function referencesContent(value: Record<string, unknown>): ReferencesContent | null {
  if (value.schema_version !== LITERATURE_SCHEMA_VERSION
    || typeof value.project !== 'string'
    || !Array.isArray(value.references)
    || !value.references.every(isReference)) return null
  return value as unknown as ReferencesContent
}

function safeUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

function referenceUrl(reference: ReferenceItem): string | null {
  return safeUrl(reference.doi ? `https://doi.org/${reference.doi}` : null)
    ?? safeUrl(reference.url)
    ?? safeUrl(reference.arxiv_id ? `https://arxiv.org/abs/${reference.arxiv_id}` : null)
}

function openReference(url: string): void {
  if (window.scholarseed?.openExternal) {
    void window.scholarseed.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noreferrer')
}

const BIBLIOGRAPHY_FILENAME = 'references.bib'
const BIBLIOGRAPHY_MIME = 'application/x-bibtex'

function bibliographyFile(references: ReferenceItem[]): File {
  return new File([searchPapersBibtex(references)], BIBLIOGRAPHY_FILENAME, { type: BIBLIOGRAPHY_MIME })
}

export function LiteratureReferences({ content }: { content: Record<string, unknown> }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const payload = useMemo(() => referencesContent(content), [content])
  if (!payload) return (
    <Card><CardHeader><CardTitle>{t('references.unavailable')}</CardTitle><CardDescription>{t('references.incompatible')}</CardDescription></CardHeader></Card>
  )
  return <ReferencesList payload={payload} />
}

function ReferencesList({ payload }: { payload: ReferencesContent }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { state } = useApp()
  // 「加入文献库」必须落在用户当前所在的作用域: 少了项目这一维, 文献会进全局分类
  // 却不关联当前项目, 于是它在自己项目的文献库里根本看不见。分类列表同理, 只列
  // 该作用域下的分类, 否则挑到的是别的作用域里同名的另一个分类。
  const projectId = state.homeSelectedProjectId ?? undefined
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, LiteratureErrorMessage | null>>({})
  const [collections, setCollections] = useState<LibraryCollection[]>([])
  const [collectionsLoading, setCollectionsLoading] = useState(false)
  const [collectionsError, setCollectionsError] = useState<LiteratureErrorMessage | null>(null)
  const [creatingFor, setCreatingFor] = useState<ReferenceItem | null>(null)
  const [createParent, setCreateParent] = useState<JoinDestination | null>(null)
  const [collectionName, setCollectionName] = useState('')
  const [createError, setCreateError] = useState<LiteratureErrorMessage | null>(null)
  const [creating, setCreating] = useState(false)
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())
  const search = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => payload.references.filter((reference) => reference.title.toLocaleLowerCase().includes(search)), [payload.references, search])
  const pageCount = Math.max(1, Math.ceil(filtered.length / REFERENCES_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visible = useMemo(() => filtered.slice((currentPage - 1) * REFERENCES_PAGE_SIZE, currentPage * REFERENCES_PAGE_SIZE), [filtered, currentPage])
  // 与文献库「加入文献库」一致的层级目录树: 由扁平分类列表按 parent_id 还原成树, 供 DestinationRows 递归渲染。
  const collectionTree = useMemo(() => collectionNodes(collections, projectId), [collections, projectId])
  const rootDestination: JoinDestination = { projectId, path: [] }

  const add = async (reference: ReferenceItem, collectionId = ''): Promise<void> => {
    if (inFlight.current.has(reference.ref_id)) return
    inFlight.current.add(reference.ref_id)
    setPending(new Set(inFlight.current))
    setErrors((current) => ({ ...current, [reference.ref_id]: null }))
    try {
      // 文献库不判重（proposal 91）：每次「加入」都新增一条，`saved` 只记录本次
      // 会话里我刚加过哪些条目，用来给出即时反馈，不代表"库里已存在"。
      const result = await importBibliography([bibliographyFile([reference])], { collectionId, projectId })
      const id = result.items[0]?.id
      if (!id) {
        setErrors((current) => ({ ...current, [reference.ref_id]: { key: 'references.noImportResult' } }))
        return
      }
      setSaved((current) => ({ ...current, [reference.ref_id]: id }))
      catalogue.reload()
    } catch (error) {
      setErrors((current) => ({ ...current, [reference.ref_id]: literatureErrorMessage(error instanceof LiteratureApiError ? error.failure.code : undefined, error instanceof Error ? error.message : undefined, 'references.addFailed') }))
    } finally {
      inFlight.current.delete(reference.ref_id)
      setPending(new Set(inFlight.current))
    }
  }

  const loadCollections = async (): Promise<void> => {
    setCollectionsLoading(true)
    setCollectionsError(null)
    try { setCollections(await listLiteratureCollections(projectId)) }
    catch (error) { setCollectionsError(literatureErrorMessage(error instanceof LiteratureApiError ? error.failure.code : undefined, error instanceof Error ? error.message : undefined, 'references.collectionsFailed')) }
    finally { setCollectionsLoading(false) }
  }
  const createAndAdd = async (): Promise<void> => {
    if (!creatingFor || !collectionName.trim() || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const name = collectionName.trim()
      const parentId = createParent?.collectionId
      const existing = collections.find((collection) => collection.name === name && (collection.parent_id || undefined) === parentId)
      const collection = existing ?? await createLiteratureCollection(name, projectId, parentId)
      catalogue.reload()
      setCreatingFor(null)
      setCreateParent(null)
      await add(creatingFor, collection.id)
    } catch (error) { setCreateError(literatureErrorMessage(error instanceof LiteratureApiError ? error.failure.code : undefined, error instanceof Error ? error.message : undefined, 'references.createFailed')) }
    finally { setCreating(false) }
  }
  const openCreate = (reference: ReferenceItem, parent: JoinDestination): void => {
    setMenuOpenFor(null)
    setCreatingFor(reference)
    setCreateParent(parent)
    setCollectionName('')
    setCreateError(null)
  }

  return (
    <>
      <Card padding="sm" className="overflow-y-hidden" data-testid="literature-references-card">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-start" aria-label={t('references.toggle')} icon={<IconFont type="line-operation-search" />}>
              <span className="font-semibold text-[var(--vds-brand-text-primary)]">{t('references.heading', { count: payload.references.length })}</span>
              {payload.project ? <span className="min-w-0 flex-1 truncate text-left font-mono text-[var(--vds-text-secondary)]">{payload.project}</span> : <span className="flex-1" />}
              <IconFont type={open ? 'a-line-switch-arrow-down-s' : 'a-line-switch-arrow-right-s'} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="!m-0 !border-0 !bg-transparent !p-0">
            <CardContent>
              <div className="border-y border-[var(--vds-divider-default)] px-[var(--vds-space-2)] py-[var(--vds-space-3)]">
                <Input type="search" aria-label={t('references.searchLabel')} placeholder={t('references.searchPlaceholder')} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
              </div>
              {visible.length ? (
                <ol className="m-0 list-none divide-y divide-[var(--vds-divider-default)] p-0">
                  {visible.map((reference) => {
                    const verification = VERIFICATION[reference.verification]
                    const error = errors[reference.ref_id]
                    const url = referenceUrl(reference)
                    const authors = reference.authors.slice(0, VISIBLE_AUTHORS).join(', ') + (reference.authors.length > VISIBLE_AUTHORS ? t('references.moreAuthors') : '')
                    const metadata = [authors, reference.venue, reference.year].filter(Boolean).join(' · ')
                    return (
                      <li key={reference.ref_id} className="px-[var(--vds-space-2)] py-[var(--vds-space-4)]">
                        <div className="flex items-start gap-[var(--vds-space-2)]">
                          <div className="min-w-0 flex-1">
                            <p className="m-0 break-words text-sm font-semibold leading-relaxed text-[var(--vds-text-primary)]">{reference.title}</p>
                            {metadata ? <p title={reference.authors.join(', ')} className="m-0 mt-[var(--vds-space-1)] truncate text-xs text-[var(--vds-text-secondary)]">{metadata}</p> : null}
                            {reference.claim ? <p title={reference.claim} className="m-0 mt-[var(--vds-space-2)] line-clamp-2 text-xs leading-relaxed text-[var(--vds-text-secondary)]">{reference.claim}</p> : null}
                          </div>
                          {/* 每条文献共用一个 menuOpenFor: 互斥已由该单值状态保证, 必须关掉 sibling-close,
                              否则某条展开时其余(关闭的)菜单收到 sibling 事件回写 onOpenChange(false),
                              会把 menuOpenFor 抹回 null, 刚展开的菜单立刻被关掉。 */}
                          <DropdownMenu closeOnSiblingOpen={false} open={menuOpenFor === reference.ref_id} onOpenChange={(isOpen) => { setMenuOpenFor(isOpen ? reference.ref_id : null); if (isOpen) void loadCollections() }}>
                            <DropdownMenuTrigger asChild>
                              <IconButton size="sm" variant="ghost" label={saved[reference.ref_id] ? t('references.chooseCollection', { title: reference.title }) : t('references.add', { title: reference.title })} icon={<IconFont type="line-operation-add" />} loading={pending.has(reference.ref_id)} disabled={pending.has(reference.ref_id)} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className={MENU_BOUNDS}>
                              <DropdownMenuItem disabled={Boolean(saved[reference.ref_id])} onSelect={() => void add(reference)}>{t('join.direct')}</DropdownMenuItem>
                              <DropdownMenuSub>
                                {/* 已添加的文献与「直接加入」同步置灰, 避免重复加入。 */}
                                <DropdownMenuSubTrigger openOnHover disabled={collectionsLoading || Boolean(saved[reference.ref_id])}>{t('join.collection')}</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className={MENU_BOUNDS} autoFocus={false}>
                                  {collectionsLoading ? <DropdownMenuItem disabled>{t('references.loadingCollections')}</DropdownMenuItem> : collectionsError ? <DropdownMenuItem onSelect={() => void loadCollections()}>{t(collectionsError.key)}{collectionsError.detail && <span> {collectionsError.detail}</span>}</DropdownMenuItem> : <DestinationRows nodes={collectionTree} parent={rootDestination} choose={(node) => { setMenuOpenFor(null); void add(reference, node.collectionId ?? '') }} create={(parent) => openCreate(reference, parent)} />}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <div className="mt-[var(--vds-space-2)] flex flex-wrap items-center gap-[var(--vds-space-2)]">
                          <Badge size="sm" tone={verification.tone}>{t(verification.labelKey)}</Badge>
                          {saved[reference.ref_id] ? <Badge size="sm" tone="neutral">{t('references.added')}</Badge> : null}
                          {url ? <Button size="sm" unstyled className="max-w-full break-all text-left font-mono text-xs text-[var(--vds-brand-text-primary)] hover:underline" onClick={() => openReference(url)}>{reference.doi || t('references.openSource')}</Button> : null}
                        </div>
                        {error ? <p role="alert" className="m-0 mt-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">{t(error.key)}{error.detail && <span> {error.detail}</span>}<span>{t('references.retryCollection')}</span></p> : null}
                      </li>
                    )
                  })}
                </ol>
              ) : <p className="m-0 p-[var(--vds-space-3)] text-[var(--vds-text-secondary)]">{search ? t('references.noMatch') : t('references.noReferences')}</p>}
              <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] px-[var(--vds-space-2)] py-[var(--vds-space-3)]">
                <p className="m-0 text-[var(--vds-text-secondary)]" role="status">{search ? t('references.filtered', { matched: filtered.length, total: payload.references.length }) : t('references.total', { count: payload.references.length })}{filtered.length ? t('references.page', { current: currentPage, total: pageCount }) : ''}</p>
                <Pagination ariaLabel={t('references.pagination')} page={currentPage} pageCount={pageCount} fullPageLimit={REFERENCES_FULL_PAGE_LIMIT} onPageChange={setPage} />
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
      <Dialog open={creatingFor !== null} onOpenChange={(isOpen) => { if (!isOpen && !creating) { setCreatingFor(null); setCreateParent(null) } }}>
        <DialogPortal>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('references.newCollection')}</DialogTitle><DialogDescription>{t('references.createDescription')}</DialogDescription></DialogHeader>
            <Input aria-label={t('references.collectionName')} placeholder={t('references.collectionPlaceholder')} value={collectionName} disabled={creating} onChange={(event) => setCollectionName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void createAndAdd() } }} />
            {createError ? <Alert tone="error">{t(createError.key)}{createError.detail && <span> {createError.detail}</span>}</Alert> : null}
            <DialogFooter><Button variant="secondary" disabled={creating} onClick={() => { setCreatingFor(null); setCreateParent(null) }}>{t('references.cancel')}</Button><Button disabled={!collectionName.trim()} loading={creating} onClick={() => void createAndAdd()}>{t('references.createAndAdd')}</Button></DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  )
}
