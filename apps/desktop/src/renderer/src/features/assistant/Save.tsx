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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  useToast,
} from '../../components/ui'
import { resourceNameError } from '../resources/state'

const FOLDER_NAME_MAX_LENGTH = 60
const INVALID_FOLDER_NAME = /[\\/:*?"<>|]/
const ROOT_FOLDER_PATH = ''

function folderPaths(nodes: ResourceNode[], parent = ROOT_FOLDER_PATH): string[] {
  return nodes.flatMap((node) => {
    if (node.kind !== 'dir') return []
    const path = parent ? `${parent}/${node.name}` : node.name
    return [path, ...folderPaths(node.children ?? [], path)]
  })
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
  tree,
  destination = 'resources',
  onDestinationChange,
  literatureContent,
  rootLabel,
  submitDisabled = false,
  nested = false,
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
  destination?: 'resources' | 'literature'
  onDestinationChange?: (destination: 'resources' | 'literature') => void
  literatureContent?: React.ReactNode
  rootLabel?: string
  submitDisabled?: boolean
  nested?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { t: resourceText } = useTranslation('resources')
  const { toast } = useToast()
  const reportedError = useRef('')
  const [draftFolders, setDraftFolders] = useState<string[]>([])
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderError, setFolderError] = useState<
    '' | 'save.folderNameRequired' | 'save.folderNameInvalid' | 'save.folderExists'
  >('')
  const knownPaths = useMemo(
    () => new Set([...folderPaths(tree), ...draftFolders]),
    [draftFolders, tree]
  )
  const nameError = resourceNameError(location.name)
  const selectLayer = nested ? '!z-[var(--vds-z-modal-nested-flyout)]' : undefined

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
    setCreatingFolder(false)
    setFolderName('')
    setFolderError('')
  }, [open])

  const selectFolder = (path: string): void => {
    onLocationChange({ ...location, parent: path })
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
          overlayClassName={nested ? '!z-[var(--vds-z-modal-nested-overlay)]' : undefined}
          portalClassName={nested ? '!z-[var(--vds-z-modal-nested-flyout)]' : undefined}
          className={`w-[min(720px,calc(100vw-48px))] max-h-[calc(100dvh-var(--vds-space-8))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 ${nested ? '!z-[var(--vds-z-modal-nested)]' : ''}`}
        >
          <DialogHeader className="border-b border-[var(--vds-border-default)] px-6 py-5">
            <DialogTitle className="text-2xl">{title}</DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-5 overflow-y-auto px-6 py-5">
            {projectOptions && onProjectChange ? (
              <Select
                disabled={saving}
                label={t('artifacts.targetProject')}
                value={selectedProjectId ?? ''}
                onValueChange={onProjectChange}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={selectLayer}>
                  {projectOptions.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="grid gap-1">
              <span className="text-sm text-[var(--vds-text-secondary)]">
                {assistantText('save.resourceName')}
              </span>
              <div className="relative">
                <Input
                  aria-label={assistantText('save.resourceName')}
                  autoFocus
                  className={fixedSuffix ? 'pr-14' : undefined}
                  error={nameError ? resourceText(nameError) : undefined}
                  maxLength={180}
                  onChange={(event) => onLocationChange({ ...location, name: event.target.value })}
                  value={location.name}
                  disabled={saving || destination === 'literature'}
                />
                {fixedSuffix ? (
                  <span className="pointer-events-none absolute right-[var(--vds-space-3)] top-1/2 -translate-y-1/2 text-[var(--vds-text-secondary)]">
                    {fixedSuffix}
                  </span>
                ) : null}
              </div>
            </div>

            {onDestinationChange && (
              <Tabs
                value={destination}
                onValueChange={(value) => onDestinationChange(value as 'resources' | 'literature')}
              >
                <TabsList className="w-full !justify-start !gap-[var(--vds-space-3)] !rounded-none !bg-transparent !p-0 border-b border-[var(--vds-divider-default)] [&>span]:hidden [&>button]:!rounded-none [&>button]:!bg-transparent [&>button]:!shadow-none [&>button]:border-b-[length:var(--vds-border-width-2)] [&>button]:border-transparent [&>button[aria-selected=true]]:!border-[var(--vds-brand-text-primary)] [&>button[aria-selected=true]]:!text-[var(--vds-brand-text-primary)]">
                  <TabsTrigger value="resources" disabled={saving}>
                    <Icon name="folder" />
                    {assistantText('save.materials')}
                  </TabsTrigger>
                  <TabsTrigger value="literature" disabled={saving}>
                    <Icon name="books" />
                    {assistantText('save.literature')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {destination === 'literature' ? (
              literatureContent
            ) : (
              <div className="grid gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--vds-text-secondary)]">
                    {assistantText('save.chooseFolder')}
                  </span>
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
                      {assistantText('remaining.createIn', {
                        name: location.parent || projectName,
                      })}
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
                      <Button onClick={createFolder} size="sm">
                        {assistantText('save.create')}
                      </Button>
                      <Button
                        onClick={() => setCreatingFolder(false)}
                        size="sm"
                        variant="secondary"
                      >
                        {assistantText('remaining.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <Select disabled={saving} value={location.parent} onValueChange={selectFolder}>
                  <SelectTrigger aria-label={assistantText('save.chooseFolder')}>
                    <SelectValue placeholder={rootLabel ?? projectName} />
                  </SelectTrigger>
                  <SelectContent className={selectLayer}>
                    <SelectItem value={ROOT_FOLDER_PATH}>{rootLabel ?? projectName}</SelectItem>
                    {[...knownPaths].map((path) => (
                      <SelectItem key={path} value={path}>
                        {path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {summary ? (
              <p className="m-0 text-sm text-[var(--vds-text-secondary)]">{summary}</p>
            ) : null}
          </div>
          <DialogFooter className="border-t border-[var(--vds-border-default)] px-6 py-4">
            <DialogClose asChild>
              <Button disabled={saving} variant="outline">
                {assistantText('remaining.cancel')}
              </Button>
            </DialogClose>
            <Button
              disabled={nameError !== null || submitDisabled}
              loading={saving}
              onClick={onSubmit}
            >
              {submitLabel ?? assistantText('save.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
