import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogPortal, DialogTitle, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui'
import type { JoinNode } from './join'

/** Shared form for sidebar creation and create-then-join; persistence stays with the caller. */
export function CreateCollectionDialog({ open, name, parentKey, options, busy, fieldsLocked, error, confirmLabel,
  onClose, onNameChange, onParentChange, onSubmit }: {
  open: boolean; name: string; parentKey: string; options: Array<{ node: JoinNode; depth: number }>
  busy: boolean; fieldsLocked?: boolean; error?: string; confirmLabel?: string
  onClose: () => void; onNameChange: (value: string) => void; onParentChange: (value: string) => void; onSubmit: () => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { input.current?.focus(); input.current?.select() } }, [open])
  const close = (): void => { if (!busy) onClose() }
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}>
    <DialogPortal><DialogContent onClick={event => event.stopPropagation()} overlayProps={{
      onPointerDown: event => { event.stopPropagation(); close() }, onClick: event => event.stopPropagation()
    }}>
      <DialogHeader><DialogTitle>{t('join.newCollection')}</DialogTitle></DialogHeader>
      <Input ref={input} label={t('join.name')} value={name} disabled={busy || fieldsLocked}
        onChange={event => onNameChange(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && name.trim()) { event.preventDefault(); onSubmit() }
        }} />
      <Select label={t('join.parent')} value={parentKey} disabled={busy || fieldsLocked} onValueChange={onParentChange}>
        <SelectTrigger aria-label={t('join.parent')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="root">{t('join.topLevel')}</SelectItem>
          {options.map(({ node, depth }) => <SelectItem key={node.key} value={node.key}>{'　'.repeat(depth + 1)}{node.name}</SelectItem>)}
        </SelectContent>
      </Select>
      {error && <p role="alert" className="text-[var(--vds-error-text-primary)]">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>{t('join.cancel')}</Button>
        <Button loading={busy} disabled={!name.trim() || busy} onClick={onSubmit}>{confirmLabel ?? t('join.create')}</Button></DialogFooter>
    </DialogContent></DialogPortal>
  </Dialog>
}
