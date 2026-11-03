import React, { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '../../components/ui'
import type { JoinNode } from './hierarchy'

export const GROUP_NAME_MAX_LENGTH = 20

/** Shared form for sidebar creation and create-then-join; persistence stays with the caller. */
export function CreateCollectionDialog({
  open,
  name,
  parentKey,
  options,
  busy,
  fieldsLocked,
  error,
  confirmLabel,
  presentation = 'collection',
  onClose,
  onNameChange,
  onParentChange,
  onSubmit,
  title,
}: {
  open: boolean
  name: string
  parentKey: string
  options: Array<{ node: JoinNode; depth: number }>
  busy: boolean
  fieldsLocked?: boolean
  error?: string
  confirmLabel?: string
  presentation?: 'collection' | 'group'
  title?: string
  onClose: () => void
  onNameChange: (value: string) => void
  onParentChange: (value: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const group = presentation === 'group'
  const validName = Boolean(name.trim()) && (!group || name.length <= GROUP_NAME_MAX_LENGTH)
  const input = useRef<HTMLInputElement>(null)
  const nameId = useId()
  useEffect(() => {
    if (open) {
      input.current?.focus()
      input.current?.select()
    }
  }, [open])
  const close = (): void => {
    if (!busy) onClose()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close()
      }}
    >
      <DialogPortal>
        <DialogContent
          aria-label={title ?? (group ? t('groups.title') : t('join.newCollection'))}
          className={
            group
              ? '!z-[var(--vds-z-modal-nested)] !w-[var(--vds-library-group-dialog-responsive-width)] !gap-[var(--vds-space-3)] !px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] !pb-[var(--vds-space-5)]'
              : undefined
          }
          overlayClassName={group ? '!z-[var(--vds-z-modal-nested-overlay)]' : undefined}
          closeButtonClassName={
            group ? '!top-[var(--vds-space-3)] !right-[var(--vds-space-5)]' : undefined
          }
          onClick={(event) => event.stopPropagation()}
          overlayProps={{
            onPointerDown: (event) => {
              event.stopPropagation()
              close()
            },
            onClick: (event) => event.stopPropagation(),
          }}
        >
          <DialogHeader
            className={
              group
                ? '!flex min-h-[var(--vds-control-height-md)] items-center !justify-start !text-left'
                : undefined
            }
          >
            <DialogTitle>
              {title ?? (group ? t('groups.title') : t('join.newCollection'))}
            </DialogTitle>
          </DialogHeader>
          <div className={group ? 'flex flex-col gap-[var(--vds-space-2)]' : 'contents'}>
            {group && (
              <Label htmlFor={nameId} required>
                {t('groups.name')}
              </Label>
            )}
            <div className="relative min-w-0">
              <Input
                ref={input}
                id={nameId}
                className={group ? 'pr-[var(--vds-space-12)]' : undefined}
                maxLength={group ? GROUP_NAME_MAX_LENGTH : undefined}
                aria-describedby={group ? `${nameId}-count` : undefined}
                aria-label={group ? t('groups.name') : undefined}
                label={group ? undefined : t('join.name')}
                placeholder={group ? t('groups.namePlaceholder') : undefined}
                required={group}
                value={name}
                disabled={busy || fieldsLocked}
                onChange={(event) => onNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    !busy &&
                    validName
                  ) {
                    event.preventDefault()
                    onSubmit()
                  }
                }}
              />
              {group && (
                <span
                  id={`${nameId}-count`}
                  className="pointer-events-none absolute right-[var(--vds-space-3)] top-1/2 -translate-y-1/2 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
                >
                  {name.length}/{GROUP_NAME_MAX_LENGTH}
                </span>
              )}
            </div>
          </div>
          {!group && (
            <Select
              label={t('join.parent')}
              value={parentKey}
              disabled={busy || fieldsLocked}
              onValueChange={onParentChange}
            >
              <SelectTrigger aria-label={t('join.parent')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="root">{t('join.topLevel')}</SelectItem>
                {options.map(({ node, depth }) => (
                  <SelectItem key={node.key} value={node.key}>
                    {'　'.repeat(depth + 1)}
                    {node.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {error && (
            <p role="alert" className="text-[var(--vds-error-text-primary)]">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t('join.cancel')}
            </Button>
            <Button loading={busy} disabled={!validName || busy} onClick={onSubmit}>
              {confirmLabel ?? t('join.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
