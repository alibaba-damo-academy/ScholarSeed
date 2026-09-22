import { onJoinedCollectionCreated, type CreatedCollectionNotice } from './joinState'
import { literatureErrorMessage, type LiteratureErrorMessage } from './error'
import { useTranslation } from 'react-i18next'
import React, { useEffect, useMemo, useState } from 'react'
import { useAccountAccess } from '../../components/business/access'
import {
  ArrowRight,
  EllipsisVertical,
  FileDown,
  Folder,
  FolderOpen,
  Link,
  LockKeyhole,
  MonitorDown,
  Pencil,
  Search,
  Trash
} from 'lucide-react'

import type {
  LiteratureCounts,
  LiteratureFacets,
  LiteratureProject
} from '../../contracts/literature'
import {
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EllipsisText,
  IconButton,
  Input,
  SearchBox,
  semanticTagColor,
  semanticTagColorFor,
  Spinner,
  Tag,
  Textarea
} from '../../components/ui'
import { Icon } from '../../icons'
import { IconFont } from '../../components/primitive'
import { useApp } from '../../store'
import {
  createLiteratureCollection,
  createLiteratureSearch,
  createLiteratureTag,
  LiteratureApiError,
  deleteLiteratureCollection,
  deleteLiteratureTag,
  getLiteratureCounts,
  getLiteratureFacets,
  getLiteratureProjects
} from './api'
import { catalogue, useCatalogue } from './catalog'
import { CollectionEditor, type CollectionEditTarget } from './Collection'
import { IMPORT_SOURCES } from './imports'
import { useSidebarBoolean, useSidebarSet } from './sidebarState'

import './literature.css'

const EMPTY_COUNTS: LiteratureCounts = {
  all: 0,
  recent: 0,
  without_collection: 0,
  unread: 0,
  without_fulltext: 0,
}
const EMPTY_FACETS: LiteratureFacets = {
  collections: [],
  tags: [],
  item_types: [],
  publications: [],
  years: []
}
const PANEL_COLLAPSIBLE_CLASS_NAME =
  'grid gap-2 border-0 bg-transparent p-0 shadow-none'
const PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME =
  "!h-5 !min-h-0 !rounded-none !border-0 !bg-transparent !px-1 !py-0 flex flex-1 items-center justify-start gap-[var(--vds-space-2)] text-left [font-family:'PingFang_SC'] text-[14px] !font-[400] leading-5 tracking-normal !text-[var(--vds-text-10)] shadow-none transition-colors hover:!bg-transparent hover:!text-[var(--vds-text-10)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-ring)]"
const PANEL_COLLAPSIBLE_ICON_CLASS_NAME =
  'inline-grid size-4 shrink-0 place-items-center text-[var(--vds-text-tertiary)] transition-transform duration-150 data-[state=closed]:-rotate-90'
type PanelError = LiteratureErrorMessage

type CreateTarget = {
  kind: 'collection'
  projectId?: string
  parentId?: string
  parentName?: string
}
type DeleteTarget =
  | { kind: 'tag'; id: string; name: string; count: number }
  | {
      kind: 'collection'
      id: string
      name: string
      count: number
      projectId?: string
    }

export function LiteraturePanel(): React.JSX.Element {
  const { act, state, set } = useApp()
  const { authenticated } = useAccountAccess(state.backendReady)
  const { t } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const projectId = state.homeSelectedProjectId ?? undefined
  const { query, reload } = useCatalogue()
  const [joinFlash, setJoinFlash] = useState<CreatedCollectionNotice | null>(null)
  useEffect(() => onJoinedCollectionCreated(notice => {
    if (projectId && notice.projectId !== projectId) return
    setLibraryOpen(true); setCollectionsOpen(true); setProjectsOpen(true)
    if (notice.projectId) setExpandedProjects(current => new Set([...current, notice.projectId!]))
    setExpandedCollections(current => new Set([...current, ...notice.ancestors]))
    setJoinFlash(notice)
  }), [projectId])
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [facets, setFacets] = useState(EMPTY_FACETS)
  const [projects, setProjects] = useState<LiteratureProject[]>([])
  const [expandedProjects, setExpandedProjects] = useSidebarSet('projects')
  const [expandedCollections, setExpandedCollections] = useSidebarSet('collections')
  const [collectionsOpen, setCollectionsOpen] = useSidebarBoolean('collectionsOpen')
  const [tagsOpen, setTagsOpen] = useSidebarBoolean('tagsOpen')
  const [projectsOpen, setProjectsOpen] = useSidebarBoolean('projectsOpen')
  const [libraryOpen, setLibraryOpen] = useSidebarBoolean('libraryOpen')
  const [discoveryOpen, setDiscoveryOpen] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const [discovery, setDiscovery] = useState('')
  const [tagSearch, setTagSearch] = useState('')
  const [tagSearchOpen, setTagSearchOpen] = useState(false)
  const [tagCreateOpen, setTagCreateOpen] = useState(false)
  const [tagCreateName, setTagCreateName] = useState('')
  const [tagCreating, setTagCreating] = useState(false)
  const [tagCreateError, setTagCreateError] = useState<PanelError | null>(null)
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null)
  const [editTarget, setEditTarget] = useState<CollectionEditTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState<PanelError | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [mutationError, setMutationError] = useState<PanelError | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchError, setSearchError] = useState<PanelError | null>(null)
  const [searching, setSearching] = useState(false)
  const selectLiteratureScope = (
    patch: Parameters<typeof catalogue.query>[0]
  ): void => {
    act.activateTab('literature')
    catalogue.query(patch)
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      getLiteratureCounts(projectId),
      getLiteratureFacets({ project_id: projectId }),
      getLiteratureProjects()
    ])
      .then(([nextCounts, nextFacets, nextProjects]) => {
        if (!active) return
        setCounts(nextCounts)
        setFacets(nextFacets)
        setProjects(nextProjects.projects)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [query.q, reload, projectId])

  useEffect(() => {
    if (!joinFlash) return
    const visible = facets.collections.some(item => item.id === joinFlash.id)
      || projects.some(project => project.collections.some(item => item.id === joinFlash.id))
    if (!visible) return
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-join-collection="${CSS.escape(joinFlash.id)}"]`)?.scrollIntoView({ block: 'nearest' }))
    const timer = window.setTimeout(() => setJoinFlash(null), 1400)
    return () => { cancelAnimationFrame(frame); clearTimeout(timer) }
  }, [joinFlash, facets, projects])

  const scope = (
    label: string,
    count: number,
    patch: Parameters<typeof catalogue.query>[0],
    active: boolean,
    key: string
  ): React.JSX.Element => (
    <Button
      key={key}
      data-sidebar-view={key}
      variant="ghost"
      size="sm"
      className={`lit-nav-row hover:!bg-[var(--vds-bg-gray-hover)] hover:[&_.lit-count]:!text-[var(--vds-brand-bg-default)] [&.is-active]:!bg-[var(--vds-bg-gray-hover)] [&.is-active]:!text-[var(--vds-brand-text-primary)] [&.is-active_.lit-count]:!text-[var(--vds-brand-text-primary)]${active ? ' is-active' : ''}`}
      onClick={() => selectLiteratureScope(patch)}
    >
      <span className="lit-nav-name">{label}</span>
      <span className="lit-count">{count}</span>
    </Button>
  )
  const clear = {
    without_collection: undefined,
    without_project: undefined,
    is_unread: undefined,
    recent: undefined,
    attachment: 'any' as const,
    collection_id: undefined,
    tag_id: undefined,
    project_id: projectId
  }
  const projectTree = useMemo(
    () =>
      projects.map((project) => {
        const byParent = new Map<string | null, typeof project.collections>()
        for (const collection of project.collections) {
          const parent = collection.parent_id ?? null
          byParent.set(parent, [...(byParent.get(parent) ?? []), collection])
        }
        return { project, byParent }
      }),
    [projects]
  )
  const toggleProject = (projectId: string): void => {
    setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }
  const toggleCollection = (collectionId: string): void => {
    setExpandedCollections((current) => {
      const next = new Set(current)
      if (next.has(collectionId)) next.delete(collectionId)
      else next.add(collectionId)
      return next
    })
  }
  const selectProject = (project: LiteratureProject): void => {
    if (
      project.collections.length > 0 &&
      query.project_id === project.id &&
      !query.collection_id
    ) {
      toggleProject(project.id)
    } else if (project.collections.length > 0) {
      setExpandedProjects((current) => new Set(current).add(project.id))
    }
    selectLiteratureScope({ ...clear, project_id: project.id })
  }
  const collectionNodes = (
    collections: LiteratureProject['collections'],
    byParent: Map<string | null, LiteratureProject['collections']>,
    project?: LiteratureProject,
    parentId: string | null = null,
    ancestors: Set<string> = new Set()
  ): React.JSX.Element[] =>
    (byParent.get(parentId) ?? []).flatMap((collection) => {
      if (ancestors.has(collection.id)) return []
      const nextAncestors = new Set(ancestors).add(collection.id)
      const childCollections = byParent.get(collection.id) ?? []
      const expanded = expandedCollections.has(collection.id)
      const active =
        query.collection_id?.includes(collection.id) === true &&
        query.project_id === (project?.id ?? projectId)
      return [
        <ContextMenu key={collection.id}>
        <ContextMenuTrigger asChild>
        <div
          className={`lit-collection-row data-[join-flash=true]:ring-2 data-[join-flash=true]:ring-[var(--vds-brand-light-border)] data-[join-flash=true]:bg-[var(--vds-brand-light-bg-default)] group/collection relative ml-[var(--vds-space-4)] flex min-w-0 items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-bg-gray-hover)] focus-within:bg-[var(--vds-bg-gray-hover)]${active ? ' is-active bg-[var(--vds-bg-gray-hover)]' : ''}`}
          key={collection.id}
          data-testid={`literature-collection-${collection.id}`}
          data-join-collection={collection.id}
          data-join-flash={joinFlash?.id === collection.id || undefined}
        >
          {childCollections.length > 0 ? (
            <IconButton
              label={t(
                expanded
                  ? 'panel.collapseCollection'
                  : 'panel.expandCollection',
                { name: collection.name }
              )}
              size="sm"
              variant="ghostIcon"
              icon={
                <span
                  aria-hidden="true"
                  className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
                  data-state={expanded ? 'open' : 'closed'}
                >
                  <Icon name="chevron-down" size={16} />
                </span>
              }
              onClick={() => toggleCollection(collection.id)}
            />
          ) : (
            <span aria-hidden="true" className="lit-tree-spacer" />
          )}
          <Button
            variant="ghost"
            size="sm"
            className={`lit-nav-row w-full !bg-transparent hover:!bg-transparent active:!bg-transparent [&.is-active]:!text-[var(--vds-brand-text-primary)] [&.is-active_.lit-count]:!text-[var(--vds-brand-text-primary)]${active ? ' is-active' : ''}`}
            onClick={() =>
              selectLiteratureScope({
                ...clear,
                project_id: project?.id ?? projectId,
                collection_id: [collection.id]
              })
            }
          >
            {expanded && childCollections.length > 0 ? (
              <FolderOpen size={14} />
            ) : (
              <Folder size={14} />
            )}
            <EllipsisText
              tooltipPortalled
              wrapperClassName="min-w-0 flex-1 text-left"
            >
              {collection.name}
            </EllipsisText>
          <span className="lit-count shrink-0 group-hover/collection:hidden group-focus-within/collection:hidden group-aria-expanded/collection:hidden">
              {collection.count}
            </span>
          </Button>
          <span className="lit-node-actions hidden flex-none gap-[calc(var(--vds-space-1)/2)] group-hover/collection:flex group-focus-within/collection:flex group-aria-expanded/collection:flex">
            <DropdownMenuTrigger asChild>
              <IconButton
                label={t('panel.moreCollection', { name: collection.name })}
                size="sm"
                variant="ghostIcon"
                icon={<EllipsisVertical size={14} />}
                onClick={(event) => event.stopPropagation()}
              />
            </DropdownMenuTrigger>
            <IconButton
              label={t('panel.newChild', { name: collection.name })}
              size="sm"
              variant="ghostIcon"
              icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
              onClick={(event) => {
                event.stopPropagation()
                openCreate({
                  kind: 'collection',
                  projectId: project?.id ?? projectId,
                  parentId: collection.id,
                  parentName: collection.name
                })
              }}
            />
          </span>
        </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => openCreate({
            kind: 'collection', projectId: project?.id ?? projectId,
            parentId: collection.id, parentName: collection.name
          })}>
            <IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />
            {t('panel.createChild')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setEditTarget({
            ...collection, projectId: project?.id ?? projectId, mode: 'rename', collections
          })}>
            <Pencil size={14} aria-hidden="true" />
            {t('panel.renameCollection')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setEditTarget({
            ...collection, projectId: project?.id ?? projectId, mode: 'move', collections
          })}>
            <Folder size={14} aria-hidden="true" />
            {t('panel.moveCollection')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setDeleteTarget({
            kind: 'collection', id: collection.id, name: collection.name,
            count: collection.count, projectId: project?.id ?? projectId
          })}>
            <Trash size={14} aria-hidden="true" />
            {t('panel.deleteCollectionAction')}
          </ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>,
        ...(expanded
          ? [
              <div
                className="ml-[var(--vds-space-4)] min-w-0"
                key={`${collection.id}-children`}
              >
                {collectionNodes(
                  collections,
                  byParent,
                  project,
                  collection.id,
                  nextAncestors
                )}
              </div>
            ]
          : [])
      ]
    })
  const visibleTags = facets.tags.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(tagSearch.trim().toLocaleLowerCase())
  )
  const openCreate = (target: CreateTarget): void => {
    setCreateTarget(target)
    setCreateName('')
    setCreateError(null)
  }
  const submitCreate = async (): Promise<void> => {
    if (creating) return
    const name = createName.trim()
    if (!name || !createTarget) {
      setCreateError({ key: 'panel.error.nameRequired' })
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await createLiteratureCollection(
        name,
        createTarget.projectId,
        createTarget.parentId
      )
      if (createTarget.projectId) {
        setExpandedProjects((current) => {
          const next = new Set(current)
          next.add(createTarget.projectId ?? '')
          return next
        })
      }
      if (createTarget.parentId) {
        setExpandedCollections((current) => {
          const next = new Set(current)
          next.add(createTarget.parentId ?? '')
          return next
        })
      }
      setCreateTarget(null)
      catalogue.reload()
    } catch (reason) {
      setCreateError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'panel.error.createFailed'
        )
      )
    } finally {
      setCreating(false)
    }
  }
  const submitTagCreate = async (): Promise<void> => {
    const name = tagCreateName.trim()
    if (!name) return
    setTagCreating(true)
    setTagCreateError(null)
    try {
      await createLiteratureTag(name)
      setTagCreateOpen(false)
      setTagCreateName('')
      catalogue.reload()
    } catch (reason) {
      setTagCreateError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'panel.error.createFailed'
        )
      )
    } finally {
      setTagCreating(false)
    }
  }
  const submitDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    setMutationError(null)
    try {
      if (deleteTarget.kind === 'collection') {
        await deleteLiteratureCollection(
          deleteTarget.id,
          deleteTarget.projectId
        )
      } else {
        await deleteLiteratureTag(deleteTarget.id)
      }
      if (
        (deleteTarget.kind === 'collection' &&
          query.collection_id?.includes(deleteTarget.id)) ||
        (deleteTarget.kind === 'tag' && query.tag_id?.includes(deleteTarget.id))
      ) {
        catalogue.query({
          ...clear,
          project_id:
            deleteTarget.kind === 'collection'
              ? deleteTarget.projectId
              : undefined
        })
      }
      setDeleteTarget(null)
      catalogue.reload()
    } catch (reason) {
      setMutationError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'panel.error.deleteFailed'
        )
      )
    } finally {
      setDeleting(false)
    }
  }
  const startSearch = async (): Promise<void> => {
    if (!authenticated || searching) return
    const query = discovery.trim()
    if (!query) {
      setSearchError({ key: 'panel.error.queryRequired' })
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const task = await createLiteratureSearch(query)
      act.openLiteratureSearch(task)
    } catch (reason) {
      setSearchError(
        literatureErrorMessage(
          reason instanceof LiteratureApiError
            ? reason.failure.code
            : undefined,
          reason instanceof Error ? reason.message : undefined,
          'panel.error.searchFailed'
        )
      )
    } finally {
      setSearching(false)
    }
  }
  return (
    <aside className="lit-side gap-4" data-testid="literature-panel" data-ob="literature">
      <h2 className="lit-library-title">
        {t(projectId ? 'navigation.project' : 'navigation.overview')}
      </h2>
      <Collapsible
        className={PANEL_COLLAPSIBLE_CLASS_NAME}
        data-ob="literature-discovery"
        open={discoveryOpen}
        onOpenChange={setDiscoveryOpen}
      >
        <CollapsibleTrigger asChild>
          <Button data-ob="literature-discovery-toggle" unstyled className={PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME}>
            <span
              aria-hidden="true"
              className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
              data-state={discoveryOpen ? 'open' : 'closed'}
            >
              <Icon name="chevron-down" size={16} />
            </span>
            <span className="font-normal">{t('panel.discover')}</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-0 bg-transparent p-0 text-[var(--vds-text-secondary)] shadow-none">
          <div data-testid="literature-search-box" className={`flex flex-col self-stretch gap-[var(--vds-space-2)] rounded-[var(--vds-radius-5)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)] shadow-none focus-within:border-[var(--vds-brand-light-border)]${authenticated ? '' : ' !rounded-b-none'}`}>
            <Textarea
              unstyled
              aria-label={t('panel.discover')}
              className="min-h-[var(--vds-control-height-standard)] w-full resize-none border-0 bg-transparent p-0 font-[family-name:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] font-normal leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] outline-none placeholder:text-[var(--vds-text-5)]"
              placeholder={t('panel.searchPlaceholder')}
              rows={2}
              value={discovery}
              onChange={(event) => setDiscovery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== 'Enter' ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                )
                  return
                event.preventDefault()
                void startSearch()
              }}
            />
            <div className="flex shrink-0 justify-end">
              <Button
                aria-label={t('panel.search')}
                className="!size-[var(--vds-control-height-sm)] !min-h-0 !min-w-[var(--vds-control-height-sm)] !p-0 [&_svg]:!size-[var(--vds-icon-7)] disabled:!bg-[var(--vds-brand-light-bg-default)] disabled:!text-[var(--vds-text-5)] disabled:!opacity-[var(--vds-opacity-full)]"
                data-testid="literature-search-submit"
                disabled={!authenticated || searching || !discovery.trim()}
                icon={
                  searching ? (
                    <Spinner size="sm" />
                  ) : (
                    <ArrowRight size={14} strokeWidth={1.8} />
                  )
                }
                size="sm"
                onClick={() => void startSearch()}
              />
            </div>
          </div>
          {!authenticated && <div className="flex items-center gap-[var(--vds-space-2)] rounded-b-[var(--vds-radius-5)] border border-t-0 border-[var(--vds-brand-light-border)] bg-[var(--vds-brand-light-bg-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-brand-text-primary)]" data-testid="literature-search-login">
            <LockKeyhole className="size-[var(--vds-icon-7)] shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t('panel.loginRequired')}</span>
            <Button size="xs" className="shrink-0" onClick={() => set({ loginOpen: true })}>{t('panel.login')}</Button>
          </div>}
        </CollapsibleContent>
      </Collapsible>
      {discoveryOpen && searchError ? (
        <Alert
          className="m-[var(--vds-space-2)]"
          tone="error"
          title={t('panel.searchFailed')}
          description={searchError.detail ?? t(searchError.key)}
        />
      ) : null}
      <div className="lit-side-scroll">
        <Collapsible
          className={PANEL_COLLAPSIBLE_CLASS_NAME}
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
        >
          <div className="flex min-h-[var(--vds-control-height-sm)] items-center">
            <CollapsibleTrigger asChild>
              <Button
                data-ob="literature-library-toggle"
                unstyled
                aria-label={
                  libraryOpen
                    ? t(projectId ? 'panel.collapseProjectLiterature' : 'panel.collapseMyLiterature')
                    : t(projectId ? 'panel.expandProjectLiterature' : 'panel.expandMyLiterature')
                }
                className={PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME}
              >
                <span
                  aria-hidden="true"
                  className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
                  data-state={libraryOpen ? 'open' : 'closed'}
                >
                  <Icon name="chevron-down" size={16} />
                </span>
                <span>{t(projectId ? 'panel.projectLiterature' : 'panel.myLiterature')}</span>
              </Button>
            </CollapsibleTrigger>
            <DropdownMenu open={importOpen} onOpenChange={setImportOpen}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  data-ob="literature-import"
                  label={t('panel.import')}
                  size="sm"
                  variant="ghostIcon"
                  className="ml-auto"
                  icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="!z-[var(--vds-z-modal)] w-52">
                {projectId ? (
                  <>
                    <DropdownMenuItem
                      data-testid="literature-link-from-overview"
                      onSelect={() => {
                        act.openWorkbenchView('literature', { returnProjectId: projectId })
                      }}
                    >
                      <Link />
                      {t('panel.linkFromOverview')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                {IMPORT_SOURCES.map((source) => (
                  <DropdownMenuItem
                    key={source.value}
                    onSelect={() => {
                      // 中区可能正被全文文档占着 (列表已卸载), 所以先把标签切回
                      // 列表, 再把导入意图交给 store 由列表消费; DOM 事件在这种
                      // 时候没有听者, 点了会静默失效。
                      act.activateTab('literature')
                      catalogue.requestImport(source.value)
                    }}
                  >
                    {source.icon === 'local-pdf' ? (
                      <MonitorDown />
                    ) : source.icon === 'bib-ris' ? (
                      <FileDown />
                    ) : (
                      <IconFont type="icon-zotero" />
                    )}
                    {t(source.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <CollapsibleContent className="border-0 bg-transparent p-0 text-[var(--vds-text-secondary)] shadow-none">
            {loading ? (
              <div className="lit-side-loading">
                <Spinner aria-label={t('panel.loading')} />
              </div>
            ) : (
              <>
                <div className="lit-nav ml-[var(--vds-space-6)]">
                  {scope(
                    t('panel.all'),
                    counts.all,
                    clear,
                      !query.without_collection &&
                      !query.is_unread &&
                      !query.recent &&
                      query.attachment !== 'without_pdf' &&
                      !query.collection_id &&
                      !query.tag_id &&
                      query.project_id === projectId,
                    'all'
                  )}
                  {scope(
                    t('panel.recent'),
                    counts.recent,
                    { ...clear, recent: true },
                    query.recent === true,
                    'recent'
                  )}
                  {scope(
                    t('panel.unfiled'),
                    counts.without_collection,
                    { ...clear, without_collection: true, without_project: projectId ? undefined : true },
                    query.without_collection === true,
                    'unorganized'
                  )}
                </div>
                <div data-ob="literature-categories" className="lit-side-section ml-[var(--vds-space-6)] flex flex-col gap-2">
                  <div className="lit-section-head">
                    <Button
                      unstyled
                      aria-label={
                        collectionsOpen
                          ? t('panel.collapseCustom')
                          : t('panel.expandCustom')
                      }
                      className={PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME}
                      onClick={() => setCollectionsOpen((value) => !value)}
                    >
                      <span
                        aria-hidden="true"
                        className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
                        data-state={collectionsOpen ? 'open' : 'closed'}
                      >
                        <Icon name="chevron-down" size={16} />
                      </span>
                      <span>
                        {t('panel.collections')}
                      </span>
                    </Button>
                    <IconButton
                      label={
                        projectId
                          ? t('panel.newProjectCollection')
                          : t('panel.newGlobalCollection')
                      }
                      size="sm"
                      variant="ghostIcon"
                      icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                      onClick={() =>
                        openCreate({ kind: 'collection', projectId })
                      }
                    />
                  </div>
                  {collectionsOpen && (
                    <div className="lit-nav">
                      {facets.collections.length === 0 ? (
                        <div className="lit-side-empty">
                          {projectId
                            ? t('panel.noCollections')
                            : t('panel.noCustom')}
                        </div>
                      ) : (
                        collectionNodes(
                          facets.collections,
                          facets.collections.reduce((tree, collection) => {
                            const parent = collection.parent_id ?? null
                            tree.set(parent, [
                              ...(tree.get(parent) ?? []),
                              collection
                            ])
                            return tree
                          }, new Map<string | null, LiteratureProject['collections']>())
                        )
                      )}
                    </div>
                  )}
                </div>
                {!projectId && projectTree.length > 0 && (
                  <div data-ob="literature-project-categories" className="lit-side-section ml-[var(--vds-space-6)] flex flex-col gap-2">
                    <div className="lit-section-head">
                      <Button
                        unstyled
                        aria-label={
                          projectsOpen
                            ? t('panel.collapseProjects')
                            : t('panel.expandProjects')
                        }
                        className={PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME}
                        onClick={() => setProjectsOpen((value) => !value)}
                      >
                        <span
                          aria-hidden="true"
                          className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
                          data-state={projectsOpen ? 'open' : 'closed'}
                        >
                          <Icon name="chevron-down" size={16} />
                        </span>
                        <span>{t('panel.projects')}</span>
                      </Button>
                    </div>
                    {projectsOpen && (
                      <div
                        className="lit-nav ml-[var(--vds-space-4)]"
                        data-testid="literature-project-tree"
                      >
                        {projectTree.length === 0 ? (
                          <div className="lit-side-empty">
                            {t('panel.noProjects')}
                          </div>
                        ) : (
                          projectTree.flatMap(({ project, byParent }) => {
                            const expanded = expandedProjects.has(project.id)
                            const active =
                              query.project_id === project.id &&
                              !query.collection_id
                            return [
                              <div
                                className="lit-project-row group/project relative flex min-w-0 items-center"
                                data-sidebar-project={project.id}
                                key={project.id}
                              >
                                <IconButton
                                  label={t(
                                    expanded
                                      ? 'panel.collapseProject'
                                      : 'panel.expandProject',
                                    { name: project.name }
                                  )}
                                  disabled={project.collections.length === 0}
                                  size="sm"
                                  variant="ghostIcon"
                                  icon={
                                    <span
                                      aria-hidden="true"
                                      className={
                                        PANEL_COLLAPSIBLE_ICON_CLASS_NAME
                                      }
                                      data-state={expanded ? 'open' : 'closed'}
                                    >
                                      <Icon name="chevron-down" size={16} />
                                    </span>
                                  }
                                  onClick={() => toggleProject(project.id)}
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={`lit-nav-row${active ? ' is-active active:!bg-[var(--vds-bg-gray-hover)]' : ' active:!bg-transparent'}`}
                                  onClick={() => selectProject(project)}
                                >
                                  <span className="lit-nav-name">
                                    {project.name}
                                  </span>
                                  <span className="lit-count transition-opacity group-hover/project:opacity-0 group-focus-within/project:opacity-0">
                                    {project.count}
                                  </span>
                                </Button>
                                <IconButton
                                  className="pointer-events-none absolute right-0 opacity-0 group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100"
                                  label={t('panel.newInProject', {
                                    name: project.name
                                  })}
                                  size="sm"
                                  variant="ghostIcon"
                                  icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
                                  onClick={() =>
                                    openCreate({
                                      kind: 'collection',
                                      projectId: project.id,
                                      parentName: project.name
                                    })
                                  }
                                />
                              </div>,
                              ...(expanded
                                ? collectionNodes(
                                    project.collections,
                                    byParent,
                                    project
                                  )
                                : [])
                            ]
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
        <div className="lit-side-section flex flex-col gap-2">
          <div className="lit-section-head h-[var(--vds-control-height-sm)] shrink-0">
            {tagSearchOpen ? (
              <>
                <Button
                  unstyled
                  aria-label={
                    tagsOpen ? t('panel.collapseTags') : t('panel.expandTags')
                  }
                  className={`${PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME} !flex-none`}
                  onClick={() => setTagsOpen((value) => !value)}
                >
                  <span
                    aria-hidden="true"
                    className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
                    data-state={tagsOpen ? 'open' : 'closed'}
                  >
                    <Icon name="chevron-down" size={16} />
                  </span>
                  <span>{t('panel.tags')}</span>
                </Button>
                <SearchBox
                  autoFocus
                  aria-label={t('panel.searchTags')}
                  placeholder={t('panel.searchTags')}
                  size="sm"
                  value={tagSearch}
                  containerClassName="min-w-0 flex-1"
                  onChange={(event) => setTagSearch(event.target.value)}
                  onBlur={() => {
                    setTagSearchOpen(false)
                    setTagSearch('')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setTagSearchOpen(false)
                      setTagSearch('')
                    }
                  }}
                />
              </>
            ) : (
              <>
                <Button
                  unstyled
                  aria-label={
                    tagsOpen ? t('panel.collapseTags') : t('panel.expandTags')
                  }
                  className={PANEL_COLLAPSIBLE_TRIGGER_CLASS_NAME}
                  onClick={() => setTagsOpen((value) => !value)}
                >
                  <span
                    aria-hidden="true"
                    className={PANEL_COLLAPSIBLE_ICON_CLASS_NAME}
                    data-state={tagsOpen ? 'open' : 'closed'}
                  >
                    <Icon name="chevron-down" size={16} />
                  </span>
                  <span>{t('panel.tags')}</span>
                </Button>
                <IconButton
                  label={t('panel.searchTags')}
                  size="sm"
                  variant="ghostIcon"
                  icon={<Search size={14} />}
                  onClick={() => setTagSearchOpen(true)}
                />
              </>
            )}
          </div>
          {tagsOpen && (
            <div className="lit-tags">
              <div className="lit-tag-cloud">
                {tagCreateOpen ? (
                  <div className="w-1/2 min-w-0">
                    <Input
                      autoFocus
                      size="sm"
                      aria-label={t('panel.newTag')}
                      placeholder={t('panel.tagName')}
                      className="!h-6 w-full min-w-0"
                      disabled={tagCreating}
                      value={tagCreateName}
                      onBlur={() => {
                        if (!tagCreateName.trim() || tagCreating) {
                          setTagCreateOpen(false)
                          setTagCreateName('')
                          setTagCreateError(null)
                        } else {
                          void submitTagCreate()
                        }
                      }}
                      onChange={(event) => setTagCreateName(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault()
                          void submitTagCreate()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setTagCreateOpen(false)
                          setTagCreateName('')
                          setTagCreateError(null)
                        }
                      }}
                    />
                  </div>
                ) : null}
                {tagCreateError ? (
                  <Alert
                    className="w-full basis-full"
                    tone="error"
                    title={t('panel.newTag')}
                    description={tagCreateError.detail ?? t(tagCreateError.key)}
                  />
                ) : null}
                {visibleTags.length === 0 ? (
                  <div className="flex items-center gap-[var(--vds-space-2)]">
                    {tagCreateOpen ? null : (
                      <IconButton
                        className="!border-1 !border-solid !border-[var(--vds-line-2)]"
                        label={t('panel.newTag')}
                        size="xs"
                        variant="ghostIcon"
                        icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-6)] !text-[length:var(--vds-icon-6)] !leading-none" />}
                        onClick={() => {
                          setTagCreateOpen(true)
                          setTagCreateName('')
                          setTagCreateError(null)
                        }}
                      />
                    )}
                    <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
                      {t('panel.noTags')}
                    </span>
                  </div>
                ) : (
                  <>
                    {tagCreateOpen ? null : (
                      <IconButton
                        className="!border-1 !border-solid !border-[var(--vds-line-2)]"
                        label={t('panel.newTag')}
                        size="xs"
                        variant="ghostIcon"
                        icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-6)] !text-[length:var(--vds-icon-6)] !leading-none" />}
                        onClick={() => {
                          setTagCreateOpen(true)
                          setTagCreateName('')
                          setTagCreateError(null)
                        }}
                      />
                    )}
                    {visibleTags.map((item) => (
                      <Tag
                        color={
                          semanticTagColor(item.color) ??
                          semanticTagColorFor(item.id)
                        }
                        className="cursor-pointer [&_.vds-tag__close]:pointer-events-none [&_.vds-tag__close]:opacity-0 hover:[&_.vds-tag__close]:pointer-events-auto hover:[&_.vds-tag__close]:opacity-100 focus:[&_.vds-tag__close]:pointer-events-auto focus:[&_.vds-tag__close]:opacity-100 focus-within:[&_.vds-tag__close]:pointer-events-auto focus-within:[&_.vds-tag__close]:opacity-100"
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        closeLabel={t('panel.deleteTag', { name: item.name })}
                        onClick={() =>
                          selectLiteratureScope({ ...clear, tag_id: [item.id] })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            selectLiteratureScope({
                              ...clear,
                              tag_id: [item.id]
                            })
                          }
                        }}
                        onClose={() =>
                          setDeleteTarget({
                            kind: 'tag',
                            id: item.id,
                            name: item.name,
                            // 删除标签作用于全库，确认框必须报全库数量而不是当前项目内的数量。
                            count: item.total
                          })
                        }
                      >
                        {item.name} <span>{item.count}</span>
                      </Tag>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {editTarget ? <CollectionEditor
        key={`${editTarget.id}:${editTarget.mode}`}
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => catalogue.reload()}
      /> : null}
      <Dialog
        open={createTarget !== null}
        onOpenChange={(open) => {
          if (!open && !creating) setCreateTarget(null)
        }}
      >
        <DialogPortal>
          <DialogContent className="lit-create-dialog">
            <DialogHeader>
              <DialogTitle>
                {t(
                  createTarget?.parentId
                    ? 'panel.createChild'
                    : 'panel.createCollection'
                )}
              </DialogTitle>
              <DialogDescription>
                {createTarget?.parentName
                  ? t('panel.createIn', { name: createTarget.parentName })
                  : t('panel.createDescription')}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              disabled={creating}
              label={t('panel.name')}
              placeholder={t('panel.collectionName')}
              value={createName}
              error={
                createError
                  ? (createError.detail ?? t(createError.key))
                  : undefined
              }
              onChange={(event) => setCreateName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submitCreate()
              }}
            />
            <DialogFooter>
              <Button variant="outline" disabled={creating} onClick={() => setCreateTarget(null)}>
                {ui('cancel')}
              </Button>
              <Button loading={creating} onClick={() => void submitCreate()}>
                {ui('create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(null)
            setMutationError(null)
          }
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t(
                  deleteTarget?.kind === 'tag'
                    ? 'panel.deleteTagTitle'
                    : 'panel.deleteCollectionTitle',
                  { name: deleteTarget?.name ?? '' }
                )}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget?.kind === 'tag'
                  ? t('panel.deleteTagDescription', {
                      count: deleteTarget.count
                    })
                  : t('panel.deleteCollectionDescription', {
                      count: deleteTarget?.count ?? 0
                    })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {mutationError ? (
              <Alert
                tone="error"
                title={t('panel.deleteFailed')}
                description={mutationError.detail ?? t(mutationError.key)}
              />
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel
                aria-disabled={deleting}
                onClick={(event) => {
                  if (deleting) event.preventDefault()
                }}
              >
                {ui('cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                aria-disabled={deleting}
                className="![background:var(--vds-error-bg-default)] ![color:var(--vds-static-white)]"
                onClick={(event) => {
                  event.preventDefault()
                  if (!deleting) void submitDelete()
                }}
              >
                {deleting ? t('panel.deleting') : ui('delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </aside>
  )
}
