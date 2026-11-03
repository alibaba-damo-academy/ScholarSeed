import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash,
  EllipsisVertical,
  Pencil,
} from 'lucide-react'

import {
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
  EllipsisText,
  IconButton,
  ScrollArea,
  Tooltip,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
} from '../../components/ui'
import {
  createLiteratureCollection,
  deleteLiteratureCollection,
  updateLiteratureCollection,
  LiteratureApiError,
  type LibraryCollection,
} from './api'
import { literatureErrorMessage, type LiteratureErrorMessage } from './error'
import { CreateCollectionDialog, GROUP_NAME_MAX_LENGTH } from './CreateCollectionDialog'

interface GroupsProps {
  projectId: string
  collections: LibraryCollection[]
  value: string
  onValueChange: (value: string) => void
  onCollectionsChange: (collections: LibraryCollection[]) => void
  onReload: () => void
}

const GROUP_ACTION_CLASS =
  '!border-0 !justify-center !p-0 !text-[var(--vds-icon-outline-default)] enabled:hover:!bg-[var(--vds-bg-white-hover-transparent)]'

export function Groups({
  projectId,
  collections,
  value,
  onValueChange,
  onCollectionsChange,
  onReload,
}: GroupsProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: layout } = useTranslation('layout')
  const { t: ui } = useTranslation('ui')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<{ id?: string; parentId?: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LibraryCollection | null>(null)
  const active = useRef(true)
  const pending = useRef(false)
  const groupList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const startCreate = (parentId?: string): void => {
    groupList.current?.focus({ preventScroll: true })
    setError(null)
    setDraft({ parentId, name: '' })
    if (parentId) setExpanded((previous) => new Set([...previous, parentId]))
  }
  const create = async (): Promise<void> => {
    if (!draft?.name.trim() || draft.name.length > GROUP_NAME_MAX_LENGTH || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const created = draft.id
        ? await updateLiteratureCollection(draft.id, { name: draft.name.trim() }, projectId)
        : await createLiteratureCollection(draft.name.trim(), projectId, draft.parentId)
      if (!active.current) return
      onCollectionsChange(
        draft.id
          ? collections.map((entry) => (entry.id === created.id ? created : entry))
          : [...collections, created]
      )
      setDraft(null)
      onReload()
    } catch (reason) {
      if (active.current)
        setError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            undefined,
            draft.id ? 'panel.error.updateFailed' : 'panel.error.createFailed'
          )
        )
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!deleteTarget || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    const removed = new Set([deleteTarget.id])
    let previousSize = 0
    while (previousSize !== removed.size) {
      previousSize = removed.size
      collections.forEach((collection) => {
        if (collection.parent_id && removed.has(collection.parent_id)) removed.add(collection.id)
      })
    }
    try {
      await deleteLiteratureCollection(deleteTarget.id, projectId)
      if (!active.current) return
      onCollectionsChange(collections.filter((collection) => !removed.has(collection.id)))
      if (removed.has(value)) onValueChange('all')
      if (draft?.parentId && removed.has(draft.parentId)) setDraft(null)
      setDeleteTarget(null)
      onReload()
    } catch (reason) {
      if (active.current)
        setError(
          literatureErrorMessage(
            reason instanceof LiteratureApiError ? reason.failure.code : undefined,
            undefined,
            'panel.error.deleteFailed'
          )
        )
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  const select = (next: string): void => {
    onValueChange(next)
    setOpen(false)
    setDraft(null)
    setError(null)
  }
  const roots = new Map<string | null, LibraryCollection[]>()
  collections.forEach((collection) => {
    const parent = collection.parent_id || null
    roots.set(parent, [...(roots.get(parent) ?? []), collection])
  })
  const rows = (parent: string | null, ancestors = new Set<string>()): React.ReactNode =>
    (roots.get(parent) ?? [])
      .filter((collection) => !ancestors.has(collection.id))
      .map((collection) => {
        const children = roots.get(collection.id) ?? []
        const isExpanded = expanded.has(collection.id)
        return (
          <React.Fragment key={collection.id}>
            <div
              data-testid="literature-group-row"
              data-selected={value === collection.id}
              className="group/collection flex items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-within:bg-[var(--vds-bg-white-hover-transparent)] data-[selected=true]:bg-[var(--vds-brand-light-bg-default)]"
              style={{ paddingInlineStart: `calc(var(--vds-space-4) * ${ancestors.size})` }}
            >
              <IconButton
                size="xs"
                variant="ghost"
                disabled={!children.length}
                className={`${GROUP_ACTION_CLASS} ${!children.length ? 'invisible' : ''}`}
                label={t('groups.expand', { name: collection.name })}
                aria-expanded={isExpanded}
                icon={isExpanded ? <ChevronDown /> : <ChevronRight />}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous)
                    if (next.has(collection.id)) next.delete(collection.id)
                    else next.add(collection.id)
                    return next
                  })
                }
              />
              <DropdownMenuRadioItem
                variant="select"
                className="min-w-0 flex-1 !pl-0 !bg-transparent aria-checked:!bg-transparent [&>svg:last-child]:hidden"
                checked={value === collection.id}
                onSelect={() => select(collection.id)}
              >
                <EllipsisText tooltip={collection.name} tooltipPortalled>
                  {collection.name}
                </EllipsisText>
              </DropdownMenuRadioItem>
              <div className="relative shrink-0">
                {value === collection.id && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex items-center justify-end pr-[var(--vds-space-3)] text-[var(--vds-brand-text-primary)] group-hover/collection:hidden group-focus-within/collection:hidden"
                  >
                    <Check className="size-[var(--vds-icon-7)]" />
                  </span>
                )}
                <div className="flex opacity-0 group-hover/collection:opacity-[var(--vds-opacity-full)] group-focus-within/collection:opacity-[var(--vds-opacity-full)]">
                  <Tooltip content={t('groups.title')} portalled side="bottom">
                    <IconButton
                      size="xs"
                      variant="ghost"
                      className={GROUP_ACTION_CLASS}
                      label={t('groups.addChild', { name: collection.name })}
                      disabled={busy}
                      icon={<Plus />}
                      onClick={() => startCreate(collection.id)}
                    />
                  </Tooltip>
                  <DropdownMenuSub>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        size="xs"
                        variant="ghost"
                        className={GROUP_ACTION_CLASS}
                        label={t('groups.more', { name: collection.name })}
                        disabled={busy}
                        icon={<EllipsisVertical />}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuSubContent side="right" align="start">
                      <DropdownMenuItem
                        onSelect={() => {
                          setError(null)
                          setDraft({ id: collection.id, name: collection.name })
                        }}
                      >
                        <Pencil />
                        {t('panel.renameCollection')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        destructive
                        onSelect={() => {
                          setError(null)
                          setDeleteTarget(collection)
                        }}
                      >
                        <Trash />
                        {t('groups.deleteAction')}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </div>
              </div>
            </div>
            {isExpanded && rows(collection.id, new Set([...ancestors, collection.id]))}
          </React.Fragment>
        )
      })
  const label =
    value === 'unfiled'
      ? t('groups.unfiled')
      : (collections.find((collection) => collection.id === value)?.name ?? layout('allPapers'))
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (busy || deleteTarget || draft) return
          setOpen(next)
          if (!next) {
            setDraft(null)
            setError(null)
          }
        }}
      >
        <Tooltip content={label} portalled side="bottom">
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="md"
              aria-label={layout('paperGroup')}
              data-library-group
              className="w-max max-w-[var(--vds-library-paper-filter-width)] group-data-[compact=true]/library-toolbar:w-[var(--vds-library-paper-filter-compact-width)] !font-[var(--vds-fw-regular)]"
            >
              <span className="min-w-0 truncate">{label}</span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          data-testid="literature-groups"
          aria-label={layout('paperGroup')}
          className="flex min-h-0 w-[var(--vds-library-group-menu-width)] max-h-[var(--vds-library-group-menu-height)] flex-col overflow-hidden"
        >
          {(['all', 'unfiled'] as const).map((option) => (
            <DropdownMenuRadioItem
              key={option}
              variant="select"
              className="shrink-0"
              checked={value === option}
              onSelect={() => select(option)}
            >
              {option === 'all' ? layout('allPapers') : t('groups.unfiled')}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <ScrollArea
            data-testid="literature-group-list"
            className="flex min-h-0 max-h-[var(--vds-library-group-menu-height)] flex-col"
            viewportClassName="min-h-0 flex-1"
          >
            <div ref={groupList} tabIndex={-1} className="outline-none">
              {rows(null)}
            </div>
          </ScrollArea>
          {collections.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            className="shrink-0 hover:!bg-[var(--vds-bg-white-hover-transparent)] [&>svg]:text-[var(--vds-icon-outline-default)]"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              startCreate()
            }}
          >
            <Plus />
            {t('groups.new')}
          </DropdownMenuItem>
          {error && !deleteTarget && !draft && (
            <p role="alert" className="p-[var(--vds-space-2)] text-[var(--vds-error-text-primary)]">
              {t(error.key)}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateCollectionDialog
        presentation="group"
        title={draft?.id ? t('panel.renameCollection') : undefined}
        open={draft !== null}
        name={draft?.name ?? ''}
        parentKey={draft?.parentId ?? 'root'}
        options={[]}
        busy={busy}
        error={draft && error ? t(error.key) : undefined}
        confirmLabel={ui('create')}
        onClose={() => {
          setDraft(null)
          setError(null)
        }}
        onNameChange={(name) => setDraft((previous) => previous && { ...previous, name })}
        onParentChange={() => {}}
        onSubmit={() => void create()}
      />
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next && !busy) {
            setDeleteTarget(null)
            setError(null)
          }
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent
            className="!z-[var(--vds-z-modal-nested)]"
            overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('groups.confirmTitle', { name: deleteTarget?.name ?? '' })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('groups.confirmDescription')}</AlertDialogDescription>
            </AlertDialogHeader>
            {error && (
              <p role="alert" className="text-[var(--vds-error-text-primary)]">
                {t(error.key)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{ui('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  void remove()
                }}
              >
                {ui('delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </>
  )
}
