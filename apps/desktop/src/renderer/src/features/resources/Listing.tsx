import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, EllipsisVertical, Plus } from 'lucide-react'

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  LIBRARY_TABLE_CLASS,
  LibraryAction,
  LibraryFilter,
  LibraryLoading,
  LibraryToolbar,
} from '../../components/business/Library'
import { libraryUpdatedAt } from '../../components/business/utils'
import { fileIconForName } from '../../components/primitive'
import { useApp } from '../../store'
import { setFileDragPreview } from '../../components/business/DragPreview'
import { writeProjectEntryDrag } from '../../drag'
import type { ResourceNode } from './state'
import { useResourceListing } from './directories'
import { resourceProjectRevision, subscribeResourceRevisions } from './revision'
import { RESOURCE_ROOT_DIRECTORY } from './lifecycle'
import { NameEditor } from './ResourcePanel'
import { resourceListingRows } from './utils'
import emptyImage from '../../assets/empty_img.webp'

const EMPTY_RESOURCE_NODES: ResourceNode[] = []

export function ResourceListing(): React.JSX.Element {
  const { state } = useApp()
  return <ProjectResourceListing key={state.homeSelectedProjectId} />
}

function ProjectResourceListing(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t, i18n } = useTranslation('layout')
  const { t: resourceText } = useTranslation('resources')
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [source, setSource] = useState('')
  const [ascending, setAscending] = useState<boolean | undefined>(undefined)
  const [facet, setFacet] = useState<'type' | 'source' | null>(null)
  const [createDirectory, setCreateDirectory] = useState<string | null>(null)
  const [emptyCreateOpen, setEmptyCreateOpen] = useState(false)
  const openedMenuPath = useRef<string | null>(null)
  const resource = state.resource
  const project = state.homeSelectedProjectId
  const keyword = query.trim().toLocaleLowerCase()
  const filtered = Boolean(keyword || type || source)
  const revision = useSyncExternalStore(subscribeResourceRevisions, () =>
    resourceProjectRevision(project)
  )
  const listing = useResourceListing(
    project,
    resource.expanded,
    filtered || facet !== null,
    revision,
    state.resourceListingRevision
  )
  const globalNodes = listing.global.snapshot ?? EMPTY_RESOURCE_NODES
  const nodes = filtered ? globalNodes : listing.nodes
  const read = filtered ? listing.global : listing.directories.get(RESOURCE_ROOT_DIRECTORY)
  const refreshing = Boolean(project) && (read?.refreshing ?? true)
  const loading = refreshing && (filtered || !read?.snapshot)
  const failed = read?.failed || (facet !== null && listing.global.failed)
  const menuNode = resource.nodeMenu
    ? nodes.find((node) => node.path === resource.nodeMenu?.path)
    : undefined
  useEffect(() => {
    if (!resource.nodeMenu || resource.nodeMenu.path !== openedMenuPath.current) {
      openedMenuPath.current = null
      return
    }
    if (!menuNode) {
      act.closeResourceMenu()
      return
    }
    if (!menuNode?.version) return
    set((current) => {
      const menu = current.resource.nodeMenu
      if (
        current.homeSelectedProjectId !== project ||
        menu?.path !== menuNode.path ||
        menu.version === menuNode.version
      )
        return current
      return {
        ...current,
        resource: { ...current.resource, nodeMenu: { ...menu, version: menuNode.version } },
      }
    })
  }, [act, menuNode, project, resource.nodeMenu, set])
  const changeFacet = (target: 'type' | 'source', open: boolean): void => {
    setFacet((previous) => (open ? target : previous === target ? null : previous))
  }
  const sourceLabel = useCallback(
    (node: ResourceNode): string =>
      node.kind === 'dir'
        ? '—'
        : node.source === 'imported'
          ? t('sourceImported')
          : node.source === 'created'
            ? t('sourceCreated')
            : node.source === 'linked'
              ? t('linkedSource')
              : '—',
    [t]
  )
  const typeLabel = useCallback(
    (node: ResourceNode): string => (node.kind === 'dir' ? t('folderType') : node.fileType || '—'),
    [t]
  )
  const facetNodes = listing.global.refreshing ? EMPTY_RESOURCE_NODES : globalNodes
  const types = useMemo(
    () => [...new Set(facetNodes.map(typeLabel))].sort().map((value) => ({ value, label: value })),
    [facetNodes, typeLabel]
  )
  const sources = useMemo(
    () =>
      [
        ...new Set(
          facetNodes.filter((node) => node.kind === 'file' && node.source).map(sourceLabel)
        ),
      ].map((value) => ({ value, label: value })),
    [facetNodes, sourceLabel]
  )
  const visible = useMemo(() => {
    const matching = filtered
      ? new Set(
          nodes
            .filter(
              (node) =>
                node.name.toLocaleLowerCase().includes(keyword) &&
                (!type || typeLabel(node) === type) &&
                (!source || sourceLabel(node) === source)
            )
            .map((node) => node.path)
        )
      : undefined
    return resourceListingRows(nodes, resource.expanded, matching, ascending)
  }, [ascending, filtered, keyword, nodes, resource.expanded, source, sourceLabel, type, typeLabel])
  const draft = resource.nameDraft
  const editor = (): React.JSX.Element => (
    <NameEditor
      value={draft?.value ?? ''}
      suffix={draft?.suffix}
      error={draft?.error}
      submitting={draft?.submitting}
      onChange={act.setResourceNameDraft}
      onCommit={act.commitResourceNameDraft}
      onCancel={act.cancelResourceNameDraft}
    />
  )
  const createMenu = (directory: string, empty = false): React.JSX.Element => (
    <DropdownMenu
      open={empty ? emptyCreateOpen : createDirectory === directory}
      onOpenChange={(open) =>
        empty
          ? setEmptyCreateOpen(open)
          : setCreateDirectory((current) =>
              open ? directory : current === directory ? null : current
            )
      }
    >
      <DropdownMenuTrigger asChild>
        {directory ? (
          <IconButton
            variant="ghost"
            size="sm"
            className="!text-[var(--vds-icon-outline-default)] aria-expanded:!bg-[var(--vds-bg-gray-active)]"
            label={resourceText('panel.createIn', { name: directory })}
            icon={<Plus />}
          />
        ) : (
          <LibraryAction
            variant={empty ? 'outline' : 'primary'}
            collapsible={!empty}
            label={t('newMaterial')}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => act.requestResourceCreate('create_document', directory)}>
          {resourceText('panel.newDocument')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => act.requestResourceCreate('create_folder', directory)}>
          {resourceText('panel.newFolder')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            set((current) => ({
              resource: {
                ...current.resource,
                importDialog: { phase: 'select', targetDir: directory },
              },
            }))
          }
        >
          {t('importMaterial')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const openMenu = (node: ResourceNode, event: React.MouseEvent): void => {
    event.preventDefault()
    openedMenuPath.current = node.path
    act.openResourceMenu({
      path: node.path,
      name: node.name,
      kind: node.kind,
      origin: node.origin,
      linkRoot: node.linkRoot,
      version: node.version,
      x: event.clientX,
      y: event.clientY,
    })
  }
  return (
    <section className={LIBRARY_PAGE_CLASS} data-testid="material-list">
      <LibraryToolbar
        searchVisible
        refreshAfterActions
        query={query}
        onQuery={setQuery}
        placeholder={t('searchFiles')}
        refreshing={refreshing}
        onRefresh={() => listing.refresh()}
      >
        {createMenu('')}
      </LibraryToolbar>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-auto rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]"
        role="region"
        aria-label={t('materials')}
        aria-busy={loading || undefined}
        tabIndex={0}
      >
        <Table
          className={`${LIBRARY_TABLE_CLASS} min-w-[var(--vds-library-material-width)] [&_th:first-child]:!w-[calc(var(--vds-library-name-column)_-_var(--vds-library-material-action-column))] [&_th:last-child]:!w-[var(--vds-library-material-action-column)] [&_th_button]:!text-[var(--vds-text-tertiary)]`}
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t('fileName')}</TableHead>
              <TableHead>
                <LibraryFilter
                  label={t('fileType')}
                  value={type}
                  options={types}
                  onChange={setType}
                  onOpenChange={(open) => changeFacet('type', open)}
                  loading={facet === 'type' && listing.global.refreshing}
                />
              </TableHead>
              <TableHead>
                <LibraryFilter
                  label={t('fileSource')}
                  value={source}
                  options={sources}
                  onChange={setSource}
                  onOpenChange={(open) => changeFacet('source', open)}
                  loading={facet === 'source' && listing.global.refreshing}
                />
              </TableHead>
              <TableHead
                aria-sort={
                  ascending === undefined ? 'none' : ascending ? 'ascending' : 'descending'
                }
              >
                <LibraryFilter
                  label={t('updatedAt')}
                  value={ascending === undefined ? '' : ascending ? 'ascending' : 'descending'}
                  includeAll={false}
                  options={[
                    { value: 'descending', label: t('timeDescending') },
                    { value: 'ascending', label: t('timeAscending') },
                  ]}
                  onChange={(value) => setAscending(value === 'ascending')}
                />
              </TableHead>
              <TableHead aria-label={t('explorerActions')} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(({ node, depth }) => {
              const FileIcon = fileIconForName(node.name, node.kind)
              const expanded = Boolean(resource.expanded[node.path]) || filtered
              const showingChildren = !filtered && node.kind === 'dir' && expanded
              const children = showingChildren ? listing.directories.get(node.path) : undefined
              const loadingChildren =
                showingChildren && (!children || (children.refreshing && !children.snapshot))
              return (
                <React.Fragment key={node.path}>
                  <TableRow
                    className="group/material hover:!bg-[var(--vds-bg-gray-hover)]"
                    key={node.path}
                    data-testid={`material-${node.path}`}
                    data-version-ready={node.version !== undefined || undefined}
                    draggable={Boolean(project) && draft?.target !== node.path}
                    onDragStart={(event) => {
                      if (!project) return
                      writeProjectEntryDrag(event.dataTransfer, project, node)
                      setFileDragPreview(event.dataTransfer, node.name, node.kind)
                    }}
                    onContextMenu={(event) => openMenu(node, event)}
                  >
                    <TableCell>
                      <div
                        className="flex min-w-0 items-center gap-[var(--vds-space-1)] pl-[calc(var(--vds-library-tree-depth)*var(--vds-material-tree-indent))]"
                        style={{ '--vds-library-tree-depth': depth } as React.CSSProperties}
                      >
                        {draft?.mode === 'rename' && draft.target === node.path ? (
                          editor()
                        ) : (
                          <Button
                            variant="ghost"
                            className="w-full min-w-0 !justify-start !px-0 !bg-transparent hover:!bg-transparent"
                            aria-expanded={node.kind === 'dir' ? expanded : undefined}
                            onClick={() =>
                              node.kind === 'file'
                                ? act.openResourceFile(node.path)
                                : void act.toggleResourceDir(node.path, false)
                            }
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className={
                                node.kind !== 'dir'
                                  ? 'invisible'
                                  : expanded
                                    ? 'rotate-90'
                                    : undefined
                              }
                            />
                            <FileIcon />
                            <EllipsisText tooltip={node.path} tooltipPortalled>
                              {node.name}
                            </EllipsisText>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="!text-[var(--vds-text-tertiary)]">
                      {typeLabel(node)}
                    </TableCell>
                    <TableCell className="!text-[var(--vds-text-tertiary)]">
                      {sourceLabel(node)}
                    </TableCell>
                    <TableCell className="!text-[var(--vds-text-tertiary)]">
                      {libraryUpdatedAt(node.updatedAt, i18n.language, Date.now(), t('justNow'))}
                    </TableCell>
                    <TableCell className="!px-[var(--vds-space-3)]">
                      <div
                        className={`flex items-center justify-end gap-[var(--vds-space-1)] ${createDirectory === node.path || resource.nodeMenu?.path === node.path ? 'opacity-[var(--vds-opacity-full)]' : 'opacity-0 group-hover/material:opacity-[var(--vds-opacity-full)] group-focus-within/material:opacity-[var(--vds-opacity-full)]'}`}
                      >
                        {node.kind === 'dir' && createMenu(node.path)}
                        <IconButton
                          variant="ghost"
                          size="sm"
                          className="!text-[var(--vds-icon-outline-default)] aria-expanded:!bg-[var(--vds-bg-gray-active)]"
                          aria-expanded={resource.nodeMenu?.path === node.path}
                          label={resourceText('panel.more', { name: node.name })}
                          icon={<EllipsisVertical />}
                          onClick={(event) => openMenu(node, event)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                  {(loadingChildren || children?.failed) && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        {loadingChildren ? (
                          <Spinner size="sm" />
                        ) : (
                          <Button variant="outline" onClick={() => listing.refresh(node.path)}>
                            {t('readFailed')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              )
            })}
            {filtered && loading && visible.length > 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Spinner size="sm" />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {loading && !visible.length && <LibraryLoading />}
        {failed && (
          <Button variant="outline" onClick={() => listing.refresh()}>
            {t('readFailed')}
          </Button>
        )}
        {!loading && !failed && !visible.length && (
          <EmptyState
            image={{ src: emptyImage, alt: '' }}
            title={t(filtered ? 'noMatchingFiles' : 'emptyFiles')}
            action={!filtered && createMenu('', true)}
          />
        )}
      </div>
    </section>
  )
}
