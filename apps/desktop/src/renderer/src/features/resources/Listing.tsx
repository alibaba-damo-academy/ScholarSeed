import React, { useEffect, useState, useSyncExternalStore } from 'react'
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
  LibraryToolbar,
} from '../../components/business/Library'
import { libraryUpdatedAt } from '../../components/business/utils'
import { fileIconForName } from '../../components/primitive'
import { useApp } from '../../store'
import { writeProjectEntryDrag } from '../../drag'
import type { ResourceNode } from './state'
import { fetchResourceListing } from './api'
import { resourceProjectRevision, subscribeResourceRevisions } from './revision'
import { subscribeFileEvents } from '../project/events'
import { refreshesResourceTree } from './lifecycle'
import { NameEditor } from './ResourcePanel'
import { resourceListingRows } from './utils'
import emptyImage from '../../assets/empty_img.webp'

export function ResourceListing(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t, i18n } = useTranslation('layout')
  const { t: resourceText } = useTranslation('resources')
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [source, setSource] = useState('')
  const [ascending, setAscending] = useState<boolean | undefined>(undefined)
  const [createDirectory, setCreateDirectory] = useState<string | null>(null)
  const [emptyCreateOpen, setEmptyCreateOpen] = useState(false)
  const [nodes, setNodes] = useState<ResourceNode[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const resource = state.resource
  const project = state.homeSelectedProjectId
  useEffect(() => {
    setQuery('')
    setType('')
    setSource('')
    setAscending(undefined)
    setNodes([])
  }, [project])
  const revision = useSyncExternalStore(subscribeResourceRevisions, () =>
    resourceProjectRevision(project)
  )
  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    if (!project) {
      setNodes([])
      setLoading(false)
      return
    }
    void fetchResourceListing(project).then((result) => {
      if (!active) return
      setLoading(false)
      setFailed(result === null)
      if (result) setNodes(result)
    })
    return () => {
      active = false
    }
  }, [project, resource.tree, revision, state.resourceRevision, refresh])
  useEffect(() => {
    if (!project) return
    return subscribeFileEvents(project, (event) => {
      if (refreshesResourceTree(event)) setRefresh((value) => value + 1)
    })
  }, [project])
  const sourceLabel = (node: ResourceNode): string =>
    node.kind === 'dir'
      ? '—'
      : node.source === 'imported'
        ? t('sourceImported')
        : node.source === 'created'
          ? t('sourceCreated')
          : node.source === 'linked'
            ? t('linkedSource')
            : '—'
  const typeLabel = (node: ResourceNode): string =>
    node.kind === 'dir' ? t('folderType') : node.fileType || '—'
  const types = [...new Set(nodes.map(typeLabel))].sort().map((value) => ({ value, label: value }))
  const sources = [
    ...new Set(nodes.filter((node) => node.kind === 'file' && node.source).map(sourceLabel)),
  ].map((value) => ({ value, label: value }))
  const matching = nodes.filter(
    (node) =>
      node.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (!type || typeLabel(node) === type) &&
      (!source || sourceLabel(node) === source)
  )
  const filtered = Boolean(query.trim() || type || source)
  const visible = resourceListingRows(
    nodes,
    resource.expanded,
    filtered ? new Set(matching.map((node) => node.path)) : undefined,
    ascending
  )
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
        refreshing={loading}
        onRefresh={() => setRefresh((value) => value + 1)}
      >
        {createMenu('')}
      </LibraryToolbar>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-auto rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]"
        role="region"
        aria-label={t('materials')}
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
                />
              </TableHead>
              <TableHead>
                <LibraryFilter
                  label={t('fileSource')}
                  value={source}
                  options={sources}
                  onChange={setSource}
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
              return (
                <React.Fragment key={node.path}>
                  <TableRow
                    className="group/material hover:!bg-[var(--vds-bg-gray-hover)]"
                    key={node.path}
                    data-testid={`material-${node.path}`}
                    draggable={Boolean(project) && draft?.target !== node.path}
                    onDragStart={(event) => {
                      if (project) writeProjectEntryDrag(event.dataTransfer, project, node)
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
                                : void act.toggleResourceDir(node.path)
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
                            <EllipsisText tooltip={node.path}>{node.name}</EllipsisText>
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
                </React.Fragment>
              )
            })}
          </TableBody>
        </Table>
        {loading && <Spinner />}
        {failed && (
          <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
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
