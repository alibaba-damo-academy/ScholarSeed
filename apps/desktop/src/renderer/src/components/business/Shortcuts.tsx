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
  type ShortcutScope,
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
  SearchBox,
} from '../ui'

const SHORTCUT_MESSAGE_KEYS = {
  markdownSave: {
    titleKey: 'commands.markdownSave.title',
    descriptionKey: 'commands.markdownSave.description',
  },
  markdownUndo: {
    titleKey: 'commands.markdownUndo.title',
    descriptionKey: 'commands.markdownUndo.description',
  },
  markdownRedo: {
    titleKey: 'commands.markdownRedo.title',
    descriptionKey: 'commands.markdownRedo.description',
  },
  markdownFind: {
    titleKey: 'commands.markdownFind.title',
    descriptionKey: 'commands.markdownFind.description',
  },
  markdownSelectAll: {
    titleKey: 'commands.markdownSelectAll.title',
    descriptionKey: 'commands.markdownSelectAll.description',
  },
  markdownBold: {
    titleKey: 'commands.markdownBold.title',
    descriptionKey: 'commands.markdownBold.description',
  },
  markdownItalic: {
    titleKey: 'commands.markdownItalic.title',
    descriptionKey: 'commands.markdownItalic.description',
  },
  markdownStrikethrough: {
    titleKey: 'commands.markdownStrikethrough.title',
    descriptionKey: 'commands.markdownStrikethrough.description',
  },
  markdownInlineCode: {
    titleKey: 'commands.markdownInlineCode.title',
    descriptionKey: 'commands.markdownInlineCode.description',
  },
  markdownLink: {
    titleKey: 'commands.markdownLink.title',
    descriptionKey: 'commands.markdownLink.description',
  },
  markdownParagraph: {
    titleKey: 'commands.markdownParagraph.title',
    descriptionKey: 'commands.markdownParagraph.description',
  },
  markdownHeading1: {
    titleKey: 'commands.markdownHeading1.title',
    descriptionKey: 'commands.markdownHeading1.description',
  },
  markdownHeading2: {
    titleKey: 'commands.markdownHeading2.title',
    descriptionKey: 'commands.markdownHeading2.description',
  },
  markdownHeading3: {
    titleKey: 'commands.markdownHeading3.title',
    descriptionKey: 'commands.markdownHeading3.description',
  },
  markdownHeading4: {
    titleKey: 'commands.markdownHeading4.title',
    descriptionKey: 'commands.markdownHeading4.description',
  },
  markdownHeading5: {
    titleKey: 'commands.markdownHeading5.title',
    descriptionKey: 'commands.markdownHeading5.description',
  },
  markdownHeading6: {
    titleKey: 'commands.markdownHeading6.title',
    descriptionKey: 'commands.markdownHeading6.description',
  },
  codeSave: {
    titleKey: 'commands.codeSave.title',
    descriptionKey: 'commands.codeSave.description',
  },
  codeSaveAll: {
    titleKey: 'commands.codeSaveAll.title',
    descriptionKey: 'commands.codeSaveAll.description',
  },
  codeUndo: {
    titleKey: 'commands.codeUndo.title',
    descriptionKey: 'commands.codeUndo.description',
  },
  codeRedo: {
    titleKey: 'commands.codeRedo.title',
    descriptionKey: 'commands.codeRedo.description',
  },
  codeFind: {
    titleKey: 'commands.codeFind.title',
    descriptionKey: 'commands.codeFind.description',
  },
  codeReplace: {
    titleKey: 'commands.codeReplace.title',
    descriptionKey: 'commands.codeReplace.description',
  },
  codeGoToLine: {
    titleKey: 'commands.codeGoToLine.title',
    descriptionKey: 'commands.codeGoToLine.description',
  },
  codeLineComment: {
    titleKey: 'commands.codeLineComment.title',
    descriptionKey: 'commands.codeLineComment.description',
  },
  codeIndent: {
    titleKey: 'commands.codeIndent.title',
    descriptionKey: 'commands.codeIndent.description',
  },
  codeOutdent: {
    titleKey: 'commands.codeOutdent.title',
    descriptionKey: 'commands.codeOutdent.description',
  },
  pdfUndo: { titleKey: 'commands.pdfUndo.title', descriptionKey: 'commands.pdfUndo.description' },
  pdfFind: { titleKey: 'commands.pdfFind.title', descriptionKey: 'commands.pdfFind.description' },
  pdfFindNext: {
    titleKey: 'commands.pdfFindNext.title',
    descriptionKey: 'commands.pdfFindNext.description',
  },
  pdfFindPrevious: {
    titleKey: 'commands.pdfFindPrevious.title',
    descriptionKey: 'commands.pdfFindPrevious.description',
  },
  pdfPreviousPage: {
    titleKey: 'commands.pdfPreviousPage.title',
    descriptionKey: 'commands.pdfPreviousPage.description',
  },
  pdfNextPage: {
    titleKey: 'commands.pdfNextPage.title',
    descriptionKey: 'commands.pdfNextPage.description',
  },
  pdfFirstPage: {
    titleKey: 'commands.pdfFirstPage.title',
    descriptionKey: 'commands.pdfFirstPage.description',
  },
  pdfLastPage: {
    titleKey: 'commands.pdfLastPage.title',
    descriptionKey: 'commands.pdfLastPage.description',
  },
  pdfGoToPage: {
    titleKey: 'commands.pdfGoToPage.title',
    descriptionKey: 'commands.pdfGoToPage.description',
  },
  pdfZoomIn: {
    titleKey: 'commands.pdfZoomIn.title',
    descriptionKey: 'commands.pdfZoomIn.description',
  },
  pdfZoomOut: {
    titleKey: 'commands.pdfZoomOut.title',
    descriptionKey: 'commands.pdfZoomOut.description',
  },
  pdfActualSize: {
    titleKey: 'commands.pdfActualSize.title',
    descriptionKey: 'commands.pdfActualSize.description',
  },
  pdfScrollUp: {
    titleKey: 'commands.pdfScrollUp.title',
    descriptionKey: 'commands.pdfScrollUp.description',
  },
  pdfScrollDown: {
    titleKey: 'commands.pdfScrollDown.title',
    descriptionKey: 'commands.pdfScrollDown.description',
  },
  pdfScrollLeft: {
    titleKey: 'commands.pdfScrollLeft.title',
    descriptionKey: 'commands.pdfScrollLeft.description',
  },
  pdfScrollRight: {
    titleKey: 'commands.pdfScrollRight.title',
    descriptionKey: 'commands.pdfScrollRight.description',
  },
  pdfScrollPageDown: {
    titleKey: 'commands.pdfScrollPageDown.title',
    descriptionKey: 'commands.pdfScrollPageDown.description',
  },
  pdfScrollPageUp: {
    titleKey: 'commands.pdfScrollPageUp.title',
    descriptionKey: 'commands.pdfScrollPageUp.description',
  },
  pdfHighlight: {
    titleKey: 'commands.pdfHighlight.title',
    descriptionKey: 'commands.pdfHighlight.description',
  },
  pdfComment: {
    titleKey: 'commands.pdfComment.title',
    descriptionKey: 'commands.pdfComment.description',
  },
  pdfCopyText: {
    titleKey: 'commands.pdfCopyText.title',
    descriptionKey: 'commands.pdfCopyText.description',
  },
} as const
const GROUP_MESSAGE_KEYS = {
  markdown: 'groups.markdown',
  code: 'groups.code',
  pdf: 'groups.pdf',
} as const

const SETTINGS_CONTENT_CLASS_NAME = 'mx-auto w-full max-w-[var(--vds-settings-content-width)]'
const SHORTCUT_GROUPS: readonly {
  id: 'markdown' | 'code' | 'pdf'
  scopes: readonly ShortcutScope[]
}[] = [
  { id: 'markdown', scopes: ['markdown'] },
  { id: 'code', scopes: ['code'] },
  { id: 'pdf', scopes: ['pdf'] },
]

function shortcutText(
  shortcut: ShortcutDefinition,
  t: ReturnType<typeof useTranslation<'shortcuts'>>['t']
): { description: string; title: string } {
  return {
    description: t(SHORTCUT_MESSAGE_KEYS[shortcut.messageKey].descriptionKey),
    title: t(SHORTCUT_MESSAGE_KEYS[shortcut.messageKey].titleKey),
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
  const conflicts =
    editingId && candidate
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
  const groups = useMemo(
    () =>
      SHORTCUT_GROUPS.flatMap((group) => {
        const label = t(GROUP_MESSAGE_KEYS[group.id])
        const shortcuts = SHORTCUTS.filter((shortcut) =>
          group.scopes.includes(shortcut.scope)
        ).filter((shortcut) => {
          if (!normalizedQuery) return true
          const text = shortcutText(shortcut, t)
          return [
            text.title,
            text.description,
            label,
            ...effectiveShortcutBindings(shortcut.id, state.shortcutOverrides).map((binding) =>
              formatShortcut(binding, platform)
            ),
          ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        })
        return shortcuts.length ? [{ ...group, label, shortcuts }] : []
      }),
    [normalizedQuery, platform, state.shortcutOverrides, t]
  )

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
        {groups.length ? (
          groups.map((group) => (
            <PageSection
              data-testid={`shortcut-group-${group.id}`}
              key={group.id}
              title={group.label}
            >
              <Card padding="none" className="!rounded-[var(--vds-settings-shortcut-card-radius)]">
                <ul className="m-0 list-none divide-y divide-[var(--vds-divider-default)] p-0">
                  {group.shortcuts.map((shortcut) => {
                    const text = shortcutText(shortcut, t)
                    const bindings = effectiveShortcutBindings(shortcut.id, state.shortcutOverrides)
                    return (
                      <li
                        className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-layout-control-gap)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]"
                        data-shortcut-id={shortcut.id}
                        key={shortcut.id}
                      >
                        <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)]">
                          <span className="font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                            {text.title}
                          </span>
                          <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                            {text.description}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-[var(--vds-space-1)]">
                          {bindings.length ? (
                            bindings.map((binding) => (
                              <kbd
                                className="rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] font-[var(--vds-font-mono)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-1-center)]"
                                key={`${binding.modifiers.join('-')}-${binding.key}`}
                              >
                                {formatShortcut(binding, platform)}
                              </kbd>
                            ))
                          ) : (
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
          ))
        ) : (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        )}
      </PageBody>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) closeEditor()
        }}
      >
        <DialogContent data-testid="shortcut-editor-dialog">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t('editor.title', { command: shortcutText(editing, t).title })
                : t('editor.fallbackTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('editor.description', { primary: platform === 'mac' ? 'Command' : 'Control' })}
            </DialogDescription>
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
            <p
              className="m-0 text-[length:var(--vds-font-caption)] text-[var(--vds-error-text-primary)]"
              role="alert"
            >
              {t('editor.invalid', { primary: platform === 'mac' ? 'Command' : 'Control' })}
            </p>
          ) : null}
          {conflicts.length ? (
            <p
              className="m-0 text-[length:var(--vds-font-caption)] text-[var(--vds-error-text-primary)]"
              role="alert"
            >
              {t('editor.conflict', {
                command: shortcutText(shortcutDefinition(conflicts[0]), t).title,
              })}
            </p>
          ) : null}
          <DialogFooter>
            {editingId &&
            Object.prototype.hasOwnProperty.call(state.shortcutOverrides, editingId) ? (
              <Button onClick={resetShortcutOverride} variant="secondary">
                {t('editor.restoreDefault')}
              </Button>
            ) : null}
            <Button onClick={clearShortcutOverride} variant="secondary">
              {t('editor.clear')}
            </Button>
            <Button onClick={closeEditor} variant="secondary">
              {t('editor.cancel')}
            </Button>
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
