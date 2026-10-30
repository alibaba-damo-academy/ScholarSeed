import { IconFont } from '../../components/primitive'
import { ArrowLeft, FileText, NotepadText, Trash } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  EllipsisText,
  EmptyState,
  IconButton,
  ScrollArea,
} from '../../components/ui'
import type { LiteratureNote } from '../../contracts/literature'
import { NoteEditor } from './NoteEditor'
import { catalogue } from './catalog'
import { LITERATURE_NOTES_CHANGED, exportNoteAsMarkdown, literatureNoteTitle } from './note'
import { useNoteAutoSave } from './autosave'

interface LiteratureNotesProps {
  itemId: string
  notes: LiteratureNote[]
  onReload: () => Promise<void>
  /**
   * 外部要求「现在就开一篇新笔记」的 nonce; 0 = 没有请求。
   *
   * 用 nonce 而不是布尔: 同一条文献连续两次从行右键菜单进来, 布尔值不变就不会再触发。
   */
  startNew?: number
  /** 新笔记已经开出来, 调用方可以回收它那份意图。 */
  onStartNew?: () => void
}

export function LiteratureNotes(props: LiteratureNotesProps): React.JSX.Element {
  return <LiteratureNotesContent key={props.itemId} {...props} />
}

function LiteratureNotesContent({
  itemId,
  notes,
  onReload,
  startNew = 0,
  onStartNew,
}: LiteratureNotesProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [pendingDelete, setPendingDelete] = useState<LiteratureNote | null>(null)
  const [exportError, setExportError] = useState('')
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload

  useEffect(() => {
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== itemId) return
      void reloadRef
        .current()
        .catch((reason) => console.error('[literature-notes] refresh failed', reason))
      catalogue.reload()
    }
    window.addEventListener(LITERATURE_NOTES_CHANGED, changed)
    return () => window.removeEventListener(LITERATURE_NOTES_CHANGED, changed)
  }, [itemId])

  const {
    draft,
    selectedId,
    isNew,
    status,
    error,
    requestOpen,
    requestNew,
    close,
    setTitle,
    setText,
    flush,
    remove,
  } = useNoteAutoSave({
    itemId,
    notes,
    reload: async () => {
      await onReload()
      catalogue.reload()
    },
  })
  // 回调挂在 ref 上: 只按 nonce 触发一次。requestNew 的身份会随草稿状态变化,
  // 放进依赖里会让用户正在写的那一篇被反复重开。
  const startRequest = useRef({ requestNew, onStartNew })
  startRequest.current = { requestNew, onStartNew }
  useEffect(() => {
    if (!startNew) return
    startRequest.current.requestNew()
    startRequest.current.onStartNew?.()
  }, [startNew])

  const sortedNotes = [...notes].sort((a, b) => b.updated_at - a.updated_at)
  const selectedIndex = sortedNotes.findIndex((note) => note.id === selectedId)
  const selected = selectedIndex >= 0 ? sortedNotes[selectedIndex] : null
  const displayPosition = selectedIndex >= 0 ? selectedIndex + 1 : sortedNotes.length + 1

  const noteTitle = (note: LiteratureNote, index: number): string =>
    literatureNoteTitle(note, index, (position) => t('readerNotes.defaultTitle', { position }))

  const requestClose = (): void => {
    if (error || exportError) {
      setExportError('')
      close()
      return
    }
    if (status === 'saved') {
      close()
      return
    }
    void flush().then((saved) => {
      if (saved) close()
    })
  }

  const exportSelected = (): void => {
    if (!draft) return
    setExportError('')
    void exportNoteAsMarkdown({ title: draft.title, text: draft.text }, displayPosition, (value) =>
      t('readerNotes.defaultTitle', { position: value })
    ).catch((reason) => {
      console.error('[literature-notes] export failed', reason)
      setExportError(t('notes.exportFailed'))
    })
  }

  const confirmRemove = async (): Promise<void> => {
    if (!pendingDelete) return
    const deleted = await remove(pendingDelete.id)
    const removedOpenNote = pendingDelete.id === selectedId
    setPendingDelete(null)
    if (deleted && removedOpenNote) close()
  }

  const deleteDialog = (
    <AlertDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open) setPendingDelete(null)
      }}
    >
      <AlertDialogPortal>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notes.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('notes.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('notes.cancel')}</AlertDialogCancel>
            <Button variant="danger" onClick={() => void confirmRemove()}>
              {t('notes.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  )

  if (draft) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-[var(--vds-space-2)] p-[var(--vds-space-3)]">
        <div className="flex min-w-0 items-center gap-[var(--vds-space-1)]">
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={requestClose}>
            {t('notes.back')}
          </Button>
        </div>
        <NoteEditor
          actions={
            !isNew && selected ? (
              <IconButton
                className="hover:!text-[var(--vds-error-text-primary)]"
                icon={<Trash size={14} />}
                label={t('notes.deleteNamed', {
                  title: noteTitle(selected, selectedIndex),
                })}
                size="sm"
                variant="ghostIcon"
                onClick={() => setPendingDelete(selected)}
              />
            ) : undefined
          }
          draft={draft}
          error={error || exportError || undefined}
          status={status}
          titlePlaceholder={t('notes.defaultTitleHint')}
          onExport={exportSelected}
          onTextChange={setText}
          onTitleChange={setTitle}
        />
        {deleteDialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-[var(--vds-space-3)] p-[var(--vds-space-3)]">
      <Button
        className="self-end"
        icon={
          <IconFont
            type="icon-line-operation-add"
            className="inline-flex shrink-0 items-center justify-center size-[var(--vds-icon-8)] !text-[length:var(--vds-icon-8)] !leading-none"
          />
        }
        variant="secondary"
        onClick={requestNew}
      >
        {t('relations.addNote')}
      </Button>

      {sortedNotes.length ? (
        <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
          <div className="flex flex-col gap-[var(--vds-space-1)] pr-[var(--vds-space-2)]">
            {sortedNotes.map((note, index) => (
              <div
                key={note.id}
                className="group/note-row flex min-w-0 items-center rounded-[var(--vds-radius-3)] hover:bg-[var(--vds-surface-hover)] focus-within:bg-[var(--vds-surface-hover)]"
              >
                <Button
                  className="h-auto min-w-0 flex-1 justify-start gap-[var(--vds-space-2)] !bg-transparent !px-[var(--vds-space-2)] !py-[var(--vds-space-3)] !text-[length:var(--vds-font-body-lv2)] hover:!bg-transparent"
                  variant="ghost"
                  onClick={() => requestOpen(note)}
                >
                  <NotepadText
                    aria-hidden="true"
                    className="shrink-0 text-[var(--vds-text-secondary)]"
                    size={16}
                  />
                  <EllipsisText tooltipPortalled wrapperClassName="flex-1 text-left">
                    {noteTitle(note, index)}
                  </EllipsisText>
                </Button>
                <IconButton
                  className="pointer-events-none mr-[var(--vds-space-2)] shrink-0 opacity-0 group-hover/note-row:pointer-events-auto group-hover/note-row:opacity-[var(--vds-opacity-full)] group-focus-within/note-row:pointer-events-auto group-focus-within/note-row:opacity-[var(--vds-opacity-full)] hover:!text-[var(--vds-error-text-primary)]"
                  icon={<Trash size={14} />}
                  label={t('notes.deleteNamed', {
                    title: noteTitle(note, index),
                  })}
                  size="sm"
                  variant="ghostIcon"
                  onClick={() => setPendingDelete(note)}
                />
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : (
        <EmptyState
          description={t('notes.emptyDescription')}
          icon={<FileText size={18} />}
          title={t('notes.emptyTitle')}
        />
      )}

      {deleteDialog}
    </div>
  )
}
