import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SHORTCUTS,
  effectiveShortcutBindings,
  findShortcutConflicts,
  formatShortcut,
  recordShortcutBinding,
  shortcutDefinition,
  shortcutPlatform,
  type ShortcutBinding,
  type ShortcutCommandId,
  type ShortcutDefinition,
  type ShortcutScope
} from '../../shortcuts'
import { useApp } from '../../store'
import { SettingsPage } from './Settings'
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  PageBody,
  PageSection,
  SearchBox
} from '../ui'

const SETTINGS_CONTENT_CLASS_NAME = 'mx-auto w-full max-w-[var(--vds-settings-content-width)]'
const SHORTCUT_GROUPS: readonly {
  id: 'markdown' | 'code' | 'pdf'
  scopes: readonly ShortcutScope[]
}[] = [
  { id: 'markdown', scopes: ['markdown'] },
  { id: 'code', scopes: ['code'] },
  { id: 'pdf', scopes: ['pdf'] }
]

function shortcutText(
  shortcut: ShortcutDefinition,
  t: ReturnType<typeof useTranslation<'shortcuts'>>['t']
): { description: string; title: string } {
  return {
    description: t(`commands.${shortcut.messageKey}.description`),
    title: t(`commands.${shortcut.messageKey}.title`)
  }
}

export function Shortcuts(): React.JSX.Element {
  const { t } = useTranslation('shortcuts')
  const { state, act } = useApp()
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<ShortcutCommandId | null>(null)
  const [candidate, setCandidate] = useState<ShortcutBinding | undefined>()
  const [recordingInvalid, setRecordingInvalid] = useState(false)
  const platform = shortcutPlatform(navigator.userAgent)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const conflicts = editingId && candidate
    ? findShortcutConflicts(editingId, candidate, state.shortcutOverrides)
    : []
  const editing = editingId ? shortcutDefinition(editingId) : null
  const openEditor = (shortcut: ShortcutDefinition): void => {
    setEditingId(shortcut.id)
    setCandidate(effectiveShortcutBindings(shortcut.id, state.shortcutOverrides)[0])
    setRecordingInvalid(false)
  }
  const closeEditor = (): void => {
    setEditingId(null)
    setCandidate(undefined)
    setRecordingInvalid(false)
  }
  const clearShortcutOverride = (): void => {
    if (editingId) act.setShortcutOverride(editingId, null)
    closeEditor()
  }
  const resetShortcutOverride = (): void => {
    if (editingId) act.resetShortcutOverride(editingId)
    closeEditor()
  }
  const groups = useMemo(() => SHORTCUT_GROUPS.flatMap(group => {
    const label = t(`groups.${group.id}`)
    const shortcuts = SHORTCUTS.filter(shortcut => group.scopes.includes(shortcut.scope)).filter(shortcut => {
      if (!normalizedQuery) return true
      const text = shortcutText(shortcut, t)
      return [text.title, text.description, label, ...effectiveShortcutBindings(shortcut.id, state.shortcutOverrides).map(binding => formatShortcut(binding, platform))]
        .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
    })
    return shortcuts.length ? [{ ...group, label, shortcuts }] : []
  }), [normalizedQuery, platform, state.shortcutOverrides, t])

  return (
    <SettingsPage
      className={SETTINGS_CONTENT_CLASS_NAME}
      data-testid="account-settings-shortcuts"
      title={t('title')}
      description={t('description')}
    >
      <SearchBox
        aria-label={t('searchLabel')}
        data-testid="shortcut-search"
        placeholder={t('searchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <PageBody>
        {groups.length ? groups.map(group => (
          <PageSection data-testid={`shortcut-group-${group.id}`} key={group.id} title={group.label}>
            <Card padding="none" className="!rounded-[var(--vds-settings-shortcut-card-radius)]">
              <ul className="m-0 list-none divide-y divide-[var(--vds-divider-default)] p-0">
                {group.shortcuts.map(shortcut => {
                  const text = shortcutText(shortcut, t)
                  const bindings = effectiveShortcutBindings(shortcut.id, state.shortcutOverrides)
                  return (
                    <li
                      className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-layout-control-gap)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]"
                      data-shortcut-id={shortcut.id}
                      key={shortcut.id}
                    >
                      <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)]">
                        <span className="font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">{text.title}</span>
                        <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">{text.description}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-[var(--vds-space-1)]">
                        {bindings.length ? bindings.map(binding => (
                          <kbd
                            className="rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] font-[var(--vds-font-mono)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-1-center)]"
                            key={`${binding.modifiers.join('-')}-${binding.key}`}
                          >
                            {formatShortcut(binding, platform)}
                          </kbd>
                        )) : (
                          <span className="text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
                            {t('unassigned')}
                          </span>
                        )}
                        <Button
                          data-testid={`shortcut-edit-${shortcut.id}`}
                          onClick={() => openEditor(shortcut)}
                          size="xs"
                          variant="ghost"
                        >
                          {t('edit')}
                        </Button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Card>
          </PageSection>
        )) : (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        )}
      </PageBody>
      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) closeEditor() }}>
        <DialogContent data-testid="shortcut-editor-dialog">
          <DialogHeader>
            <DialogTitle>{editing ? t('editor.title', { command: shortcutText(editing, t).title }) : t('editor.fallbackTitle')}</DialogTitle>
            <DialogDescription>{t('editor.description', { primary: platform === 'mac' ? 'Command' : 'Control' })}</DialogDescription>
          </DialogHeader>
          <Button
            autoFocus
            className="min-h-[var(--vds-control-height-lg)] w-full justify-center font-[var(--vds-font-mono)]"
            data-testid="shortcut-recorder"
            onKeyDown={(event) => {
              if (event.key === 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              const recorded = recordShortcutBinding(event.nativeEvent, platform)
              setRecordingInvalid(!recorded)
              if (recorded) setCandidate(recorded)
            }}
            variant="outline"
          >
            {candidate ? formatShortcut(candidate, platform) : t('editor.recordPrompt')}
          </Button>
          {recordingInvalid ? (
            <p className="m-0 text-[length:var(--vds-font-caption)] text-[var(--vds-error-text-primary)]" role="alert">
              {t('editor.invalid', { primary: platform === 'mac' ? 'Command' : 'Control' })}
            </p>
          ) : null}
          {conflicts.length ? (
            <p className="m-0 text-[length:var(--vds-font-caption)] text-[var(--vds-error-text-primary)]" role="alert">
              {t('editor.conflict', {
                command: shortcutText(shortcutDefinition(conflicts[0]), t).title
              })}
            </p>
          ) : null}
          <DialogFooter>
            {editingId && Object.prototype.hasOwnProperty.call(state.shortcutOverrides, editingId) ? (
              <Button onClick={resetShortcutOverride} variant="secondary">
                {t('editor.restoreDefault')}
              </Button>
            ) : null}
            <Button onClick={clearShortcutOverride} variant="secondary">
              {t('editor.clear')}
            </Button>
            <Button onClick={closeEditor} variant="secondary">{t('editor.cancel')}</Button>
            <Button
              disabled={!editingId || !candidate || conflicts.length > 0}
              onClick={() => {
                if (!editingId || !candidate) return
                act.setShortcutOverride(editingId, candidate)
                closeEditor()
              }}
            >
              {t('editor.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  )
}
