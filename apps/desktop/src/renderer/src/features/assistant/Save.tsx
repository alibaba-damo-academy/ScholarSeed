import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ResourceLocationRef, ResourceNode } from '../../contracts/resources'
import { Icon } from '../../icons'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Input,
  ScrollArea,
  Select,
  useToast
} from '../../components/ui'
import { resourceNameError } from '../resources/state'

const FOLDER_NAME_MAX_LENGTH = 60
const INVALID_FOLDER_NAME = /[\\/:*?"<>|]/
const ROOT_FOLDER_PATH = ''

interface FolderItem {
  children: FolderItem[]
  draft: boolean
  name: string
  path: string
}

function resourceFolders(nodes: ResourceNode[], parent = ROOT_FOLDER_PATH): FolderItem[] {
  return nodes.flatMap((node) => {
    if (node.kind !== 'dir') return []
    const path = parent ? `${parent}/${node.name}` : node.name
    return [{
      children: resourceFolders(node.children ?? [], path),
      draft: false,
      name: node.name,
      path
    }]
  })
}

function insertDraftFolder(items: FolderItem[], path: string): FolderItem[] {
  const parts = path.split('/').filter(Boolean)
  const insert = (rows: FolderItem[], depth: number, parent: string): FolderItem[] => {
    const name = parts[depth]
    if (!name) return rows
    const itemPath = parent ? `${parent}/${name}` : name
    const existing = rows.find((row) => row.name === name)
    if (existing) {
      return rows.map((row) => row !== existing ? row : {
        ...row,
        children: insert(row.children, depth + 1, itemPath)
      })
    }
    const created: FolderItem = { children: [], draft: true, name, path: itemPath }
    created.children = insert(created.children, depth + 1, itemPath)
    return [...rows, created]
  }
  return insert(items, 0, ROOT_FOLDER_PATH)
}

function folderItems(nodes: ResourceNode[], drafts: string[]): FolderItem[] {
  return drafts.reduce(insertDraftFolder, resourceFolders(nodes))
}

function folderPaths(items: FolderItem[]): string[] {
  return items.flatMap((item) => [item.path, ...folderPaths(item.children)])
}

function FolderRow({
  depth,
  expanded,
  item,
  onExpand,
  onSelect,
  selected
}: {
  depth: number
  expanded: Set<string>
  item: FolderItem
  onExpand: (path: string) => void
  onSelect: (path: string) => void
  selected: string
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const open = expanded.has(item.path)
  const hasChildren = item.children.length > 0
  return (
    <>
      <div
        className={`flex items-center border-b border-[var(--vds-border-default)] ${
          selected === item.path ? 'bg-[var(--vds-brand-light-bg-default)]' : ''
        }`}
        style={{ paddingLeft: `${12 + depth * 24}px` }}
      >
        <Button
          aria-label={hasChildren ? t(open ? 'save.collapseFolder' : 'save.expandFolder', { name: item.name }) : undefined}
          className="size-8 min-w-8 px-0"
          disabled={!hasChildren}
          onClick={() => onExpand(item.path)}
          size="sm"
          variant="ghost"
        >
          {hasChildren ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /> : null}
        </Button>
        <Button
          className="min-w-0 flex-1 justify-start rounded-none px-1 py-3 text-left"
          icon={<Icon name="folder" size={17} />}
          onClick={() => onSelect(item.path)}
          variant="ghost"
        >
          <span className="truncate">{item.name}</span>
          {item.draft ? (
            <span className="ml-auto text-xs font-normal text-[var(--vds-text-tertiary)]">{t('save.createdOnSave')}</span>
          ) : null}
          {selected === item.path ? <span aria-hidden="true" className="text-base">✓</span> : null}
        </Button>
      </div>
      {open ? item.children.map((child) => (
        <FolderRow
          depth={depth + 1}
          expanded={expanded}
          item={child}
          key={child.path}
          onExpand={onExpand}
          onSelect={onSelect}
          selected={selected}
        />
      )) : null}
    </>
  )
}

export function ResourceSaveDialog({
  description,
  error,
  fixedSuffix,
  location,
  onLocationChange,
  onOpenChange,
  onSubmit,
  open,
  projectName,
  projectOptions,
  selectedProjectId,
  onProjectChange,
  saving,
  submitLabel,
  summary,
  title,
  tree
}: {
  description: string
  error: string
  fixedSuffix?: string
  location: ResourceLocationRef
  onLocationChange: (location: ResourceLocationRef) => void
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
  open: boolean
  projectName: string
  projectOptions?: readonly { id: string; name: string }[]
  selectedProjectId?: string
  onProjectChange?: (projectId: string) => void
  saving: boolean
  submitLabel?: string
  summary?: string
  title: string
  tree: ResourceNode[]
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { t: resourceText } = useTranslation('resources')
  const { toast } = useToast()
  const reportedError = useRef('')
  const [draftFolders, setDraftFolders] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState<'' | 'save.folderNameRequired' | 'save.folderNameInvalid' | 'save.folderExists'>('')
  const folders = useMemo(() => folderItems(tree, draftFolders), [draftFolders, tree])
  const knownPaths = useMemo(() => new Set(folderPaths(folders)), [folders])
  const nameError = resourceNameError(location.name)

  useEffect(() => {
    if (!open || !error) {
      reportedError.current = ''
      return
    }
    if (reportedError.current === error) return
    reportedError.current = error
    toast({ tone: 'error', title: assistantText('remaining.correctRetry', { detail: error }) })
  }, [assistantText, error, open, toast])

  useEffect(() => {
    if (!open) return
    setDraftFolders([])
    setExpanded(new Set())
    setCreatingFolder(false)
    setFolderName('')
    setFolderError('')
  }, [open])

  const selectFolder = (path: string): void => {
    onLocationChange({ ...location, parent: path })
  }

  const toggleFolder = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const createFolder = (): void => {
    const name = folderName.trim()
    if (!name) {
      setFolderError('save.folderNameRequired')
      return
    }
    if (INVALID_FOLDER_NAME.test(name)) {
      setFolderError('save.folderNameInvalid')
      return
    }
    const path = location.parent ? `${location.parent}/${name}` : name
    if (knownPaths.has(path)) {
      setFolderError('save.folderExists')
      return
    }
    setDraftFolders((current) => [...current, path])
    setExpanded((current) => new Set([...current, location.parent].filter(Boolean)))
    onLocationChange({ ...location, parent: path })
    setCreatingFolder(false)
    setFolderName('')
    setFolderError('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogContent
          aria-label={title}
          className="w-[min(720px,calc(100vw-48px))] max-w-none gap-0 overflow-hidden p-0"
        >
          <DialogHeader className="border-b border-[var(--vds-border-default)] px-6 py-5">
            <DialogTitle className="text-2xl">{title}</DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 px-6 py-5">
          {projectOptions && onProjectChange ? (
            <Select
              disabled={saving}
              label={t('artifacts.targetProject')}
              value={selectedProjectId ?? ''}
              onValueChange={onProjectChange}
            >
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          ) : null}
          <div className="grid gap-1">
            <span className="text-sm text-[var(--vds-text-secondary)]">{assistantText('save.resourceName')}</span>
            <div className="relative">
              <Input
                aria-label={assistantText('save.resourceName')}
                autoFocus
                className={fixedSuffix ? 'pr-14' : undefined}
                error={nameError ? resourceText(nameError) : undefined}
                maxLength={180}
                onChange={(event) => onLocationChange({ ...location, name: event.target.value })}
                value={location.name}
              />
              {fixedSuffix ? (
                <span className="pointer-events-none absolute right-[var(--vds-space-3)] top-1/2 -translate-y-1/2 text-[var(--vds-text-secondary)]">
                  {fixedSuffix}
                </span>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--vds-text-secondary)]">{assistantText('save.chooseFolder')}</span>
              <Button
                icon={<Icon name="folder-plus" size={16} />}
                onClick={() => {
                  setCreatingFolder(true)
                  setFolderError('')
                }}
                size="sm"
                variant="ghost"
              >
                {assistantText('remaining.newFolder')}
              </Button>
            </div>

            {creatingFolder ? (
              <div className="grid gap-2 rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-hover)] p-3">
                <span className="text-xs text-[var(--vds-text-secondary)]">
                  {assistantText('remaining.createIn', { name: location.parent || projectName })}
                </span>
                <div className="flex items-end gap-2">
                  <Input
                    autoFocus
                    className="flex-1"
                    error={folderError ? assistantText(folderError) : undefined}
                    label={assistantText('save.folderName')}
                    maxLength={FOLDER_NAME_MAX_LENGTH}
                    onChange={(event) => {
                      setFolderName(event.target.value)
                      setFolderError('')
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        createFolder()
                      }
                    }}
                    value={folderName}
                  />
                  <Button onClick={createFolder} size="sm">{assistantText('save.create')}</Button>
                  <Button onClick={() => setCreatingFolder(false)} size="sm" variant="secondary">
                    {assistantText('remaining.cancel')}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)]">
              <div className={location.parent === ROOT_FOLDER_PATH ? 'bg-[var(--vds-brand-light-bg-default)]' : ''}>
                <Button
                  className="w-full justify-start rounded-none px-4 py-3 text-left"
                  icon={<Icon name="folder" size={18} />}
                  onClick={() => selectFolder(ROOT_FOLDER_PATH)}
                  variant="ghost"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{projectName}</span>
                  {location.parent === ROOT_FOLDER_PATH ? (
                    <span aria-hidden="true" className="text-base">✓</span>
                  ) : null}
                </Button>
              </div>
              <ScrollArea className="max-h-[340px]" viewportClassName="max-h-[340px]">
                {folders.length ? folders.map((item) => (
                  <FolderRow
                    depth={0}
                    expanded={expanded}
                    item={item}
                    key={item.path}
                    onExpand={toggleFolder}
                    onSelect={selectFolder}
                    selected={location.parent}
                  />
                )) : (
                  <p className="m-0 px-4 py-5 text-sm text-[var(--vds-text-tertiary)]">
                    {assistantText('remaining.emptyFolders')}
                  </p>
                )}
              </ScrollArea>
            </div>
          </div>

          {summary ? <p className="m-0 text-sm text-[var(--vds-text-secondary)]">{summary}</p> : null}
          </div>
          <DialogFooter className="border-t border-[var(--vds-border-default)] px-6 py-4">
            <DialogClose asChild>
              <Button disabled={saving} variant="outline">{assistantText('remaining.cancel')}</Button>
            </DialogClose>
            <Button disabled={nameError !== null} loading={saving} onClick={onSubmit}>
              {submitLabel ?? assistantText('save.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
