import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle, Input, ScrollArea } from '../../components/ui'
import { LiteratureApiError, updateLiteratureCollection, type LibraryCollection } from './api'
import { literatureErrorMessage, type LiteratureErrorMessage } from './error'

export interface CollectionEditTarget {
  id: string
  name: string
  parent_id?: string | null
  projectId?: string
  mode: 'rename' | 'move'
  collections: LibraryCollection[]
}

export function CollectionEditor({ target, onClose, onSaved }: {
  target: CollectionEditTarget
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const [name, setName] = useState(target.name)
  const [parentId, setParentId] = useState<string | null>(target.parent_id ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<LiteratureErrorMessage | null>(null)
  const moving = target.mode === 'move'
  const submit = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await updateLiteratureCollection(target.id, moving ? { parent_id: parentId } : { name: name.trim() }, target.projectId)
      onSaved()
      onClose()
    } catch (reason) {
      setError(literatureErrorMessage(
        reason instanceof LiteratureApiError ? reason.failure.code : undefined,
        reason instanceof Error ? reason.message : undefined,
        'panel.error.updateFailed'
      ))
    } finally {
      setSaving(false)
    }
  }
  const nodes = (parent: string | null, ancestors: ReadonlySet<string> = new Set()): React.ReactNode =>
    target.collections.filter((entry) => (entry.parent_id ?? null) === parent && !ancestors.has(entry.id)).map((entry) => {
      const blocked = entry.id === target.id
      return <div key={entry.id} className="ml-[var(--vds-space-4)]">
        <Button
          className="w-full justify-start"
          variant={parentId === entry.id ? 'secondary' : 'ghost'}
          disabled={blocked || saving}
          aria-pressed={parentId === entry.id}
          data-testid={`collection-destination-${entry.id}`}
          onClick={() => setParentId(entry.id)}
        >{entry.name}</Button>
        {blocked ? null : nodes(entry.id, new Set([...ancestors, entry.id]))}
      </div>
    })
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    {/* 渲染在文献面板内会被祖先 stacking context 困住，遮罩盖不住活动栏/分栏拖拽条/AI composer；提到 body 与同文件创建、删除弹窗一致。 */}
    <DialogPortal>
      <DialogContent className="!flex !flex-col max-h-[calc(100dvh-var(--vds-space-6))] overflow-hidden" data-testid="collection-editor">
        <DialogHeader>
          <DialogTitle>{t(moving ? 'panel.moveTo' : 'panel.renameCollection')}</DialogTitle>
          <DialogDescription>{t(moving ? 'panel.moveDescription' : 'panel.renameDescription', { name: target.name })}</DialogDescription>
        </DialogHeader>
        {error ? <Alert tone="error" title={t('panel.error.updateFailed')} description={error.detail ?? t(error.key)} /> : null}
        {moving ? <ScrollArea className="min-h-0 flex-1">
          <Button
            className="w-full justify-start"
            variant={parentId === null ? 'secondary' : 'ghost'}
            disabled={saving}
            aria-pressed={parentId === null}
            onClick={() => setParentId(null)}
          >{t(target.projectId ? 'panel.projectRoot' : 'panel.globalRoot')}</Button>
          {nodes(null)}
        </ScrollArea> : <Input
          autoFocus
          label={t('panel.name')}
          value={name}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && name.trim()) void submit()
          }}
        />}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>{ui('cancel')}</Button>
          <Button
            loading={saving}
            disabled={moving ? parentId === (target.parent_id ?? null) : !name.trim()}
            onClick={() => void submit()}
          >{ui('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </Dialog>
}
