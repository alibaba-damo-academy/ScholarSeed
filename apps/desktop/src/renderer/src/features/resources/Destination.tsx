import { IconFont } from '../../components/primitive'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  useToast
} from '../../components/ui'
import { Icon } from '../../icons'
import { DestinationTree } from '../../components/business/Destination'
import type { ResourceNode } from './state'
import { DestinationFeedback, ResourceFailure, type DestinationFailure } from './Feedback'

const RESOURCE_FOLDER_NAME_LIMIT = 180

export function WebImportDestination({
  busy,
  onConfirm,
  onCreateFolder,
  onExpandFolder,
  onOpenChange,
  onSelect,
  open,
  projectName,
  selectedCount,
  selectedParent,
  tree
}: {
  busy: boolean
  onConfirm: () => void
  onCreateFolder: (name: string) => Promise<DestinationFailure | undefined>
  onExpandFolder: (path: string) => void
  onOpenChange: (open: boolean) => void
  onSelect: (parent: string, nodePath: string) => void
  open: boolean
  projectName: string
  selectedCount: number
  selectedParent: string
  tree: ResourceNode[]
}): React.JSX.Element {
  const { toast } = useToast()
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)

  useEffect(() => {
    if (open) return
    setExpanded({})
    setNewFolderOpen(false)
    setNewFolderName('')
  }, [open])

  const toggleFolder = (path: string): void => {
    const next = !(expanded[path] ?? false)
    setExpanded((current) => ({ ...current, [path]: next }))
    if (next) onExpandFolder(path)
  }

  const createFolder = async (): Promise<void> => {
    const name = newFolderName.trim()
    if (!name || creatingFolder || busy) return
    setCreatingFolder(true)
    const failure = await onCreateFolder(name)
    setCreatingFolder(false)
    if (failure) {
      toast({
        description: <ResourceFailure message={failure} />,
        title: <DestinationFeedback message={{ key: 'destination.failed' }} />,
        tone: 'error'
      })
      return
    }
    setNewFolderOpen(false)
    setNewFolderName('')
    toast({
      description: <DestinationFeedback message={{ key: 'destination.createdDescription', name }} />,
      title: <DestinationFeedback message={{ key: 'destination.created' }} />,
      tone: 'success'
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (busy || creatingFolder)) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        aria-label={t('destination.label')}
        data-testid="web-search-import-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('destination.title')}</DialogTitle>
          <DialogDescription>
            {t('destination.description', { total: selectedCount })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-[var(--vds-space-2)]">
          <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
            {t('destination.target')}
          </span>
          <div className="rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-2)]">
            <Button
              className="w-full !justify-start"
              data-testid="web-import-folder-root"
              icon={<Icon name="inbox" size={14} />}
              variant={selectedParent === '' ? 'secondary' : 'ghost'}
              onClick={() => onSelect('', '')}
            >
              <span className="truncate">{t('destination.projectRoot', { name: projectName })}</span>
              {selectedParent === '' ? <span className="ml-auto" aria-label={t('destination.selected')}>✓</span> : null}
            </Button>
            <DestinationTree
              nodes={tree}
              selected={selectedParent}
              expanded={expanded}
              onToggle={toggleFolder}
              onSelect={(value, node) => onSelect(value, node.path)}
              selectionValue={(node) => {
                const prefix = tree[0]?.path.endsWith(tree[0].name)
                  ? tree[0].path.slice(0, -tree[0].name.length) : ''
                return prefix && node.path.startsWith(prefix) ? node.path.slice(prefix.length) : node.path
              }}
              disabled={busy}
            />
          </div>
          <span
            className="truncate text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
            title={selectedParent || t('destination.root')}
          >
            {selectedParent ? t('destination.destination', { path: selectedParent }) : t('destination.destinationRoot')}
          </span>
        </div>

        {newFolderOpen ? (
          <div className="grid gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)]">
            <Input
              autoFocus
              label={t('destination.name')}
              maxLength={RESOURCE_FOLDER_NAME_LIMIT}
              value={newFolderName}
              onChange={(event) => {
                setNewFolderName(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createFolder()
                }
              }}
            />
            <div className="flex justify-end gap-[var(--vds-space-2)]">
              <Button
                disabled={creatingFolder}
                variant="ghost"
                onClick={() => {
                  setNewFolderOpen(false)
                  setNewFolderName('')
                }}
              >
                {uiText('cancel')}
              </Button>
              <Button
                disabled={!newFolderName.trim()}
                loading={creatingFolder}
                onClick={() => void createFolder()}
              >
                {t('destination.create')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="justify-self-start"
            icon={<IconFont type="icon-line-operation-add" className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-7)] !text-[length:var(--vds-icon-7)] !leading-none" />}
            variant="secondary"
            onClick={() => setNewFolderOpen(true)}
          >
            {t('destination.newFolder')}
          </Button>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy || creatingFolder} variant="outline">{uiText('cancel')}</Button>
          </DialogClose>
          <Button
            data-testid="web-search-import-confirm"
            disabled={selectedCount === 0 || creatingFolder}
            loading={busy}
            onClick={onConfirm}
          >
            {t('destination.import', { total: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
