import { ArrowLeft, ArrowUpFromLine, BookText, Download, Trash } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { Markdown } from '../../components/primitive'
import {
  Alert,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  EllipsisText,
  EmptyState,
  IconButton,
  ScrollArea,
  Spinner,
} from '../../components/ui'
import type { LiteratureNote } from '../../contracts/literature'
import type { DocumentPanelPresentation } from '../../contracts/features'
import { NoteEditor } from './NoteEditor'
import { NoteSources } from './NoteSources'
import { NoteIndex } from './NoteIndex'
import { LITERATURE_NOTES_CHANGED, exportNoteAsMarkdown, literatureNoteTitle } from './note'
import { useNoteAutoSave } from './autosave'
import { literatureNoteSummary } from './synopsis'
import { useNoteGeneration } from './generation'

const NOTE_CARD_CLASS =
  'flex min-w-0 items-start rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]'
const NOTE_CARD_TITLE_CLASS = 'w-full font-[var(--vds-fw-semibold)]'
const NOTE_CARD_SUMMARY_CLASS =
  'mt-[var(--vds-space-1)] line-clamp-2 whitespace-normal [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]'
const NOTE_CARD_TRAILING_CLASS = 'mt-[var(--vds-space-2)] mr-[var(--vds-space-2)] shrink-0'

interface LiteratureNotesProps {
  itemId: string
  notes: LiteratureNote[]
  onReload: () => Promise<void>
  reader?: DocumentPanelPresentation
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
  reader,
}: LiteratureNotesProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [pendingDelete, setPendingDelete] = useState<LiteratureNote | null>(null)
  const [exportError, setExportError] = useState('')
  const generation = useNoteGeneration(itemId)
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload

  useEffect(() => {
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== itemId) return
      void reloadRef
        .current()
        .catch((reason) => console.error('[literature-notes] refresh failed', reason))
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
    requestClose: close,
    setTitle,
    setText,
    flush,
    remove,
    removingId,
  } = useNoteAutoSave({
    itemId,
    notes,
  })
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (generation.pending) void closeRef.current()
  }, [generation.pending])
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
    void close().then((closed) => {
      if (closed) setExportError('')
    })
  }

  const exportListed = (note: LiteratureNote, index: number): void => {
    setExportError('')
    void exportNoteAsMarkdown(note, index + 1, (position) =>
      t('readerNotes.defaultTitle', { position })
    ).catch(() => setExportError(t('notes.exportFailed')))
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
    if (deleted) setPendingDelete(null)
  }

  const headerExport = reader?.headerActionsHost
    ? createPortal(
        <IconButton
          data-testid="reader-notes-export"
          label={t('readerNotes.export')}
          icon={<ArrowUpFromLine className="size-[var(--vds-icon-8)]" />}
          size="sm"
          variant="ghostIcon"
          disabled={!draft || Boolean(removingId)}
          onClick={exportSelected}
        />,
        reader.headerActionsHost
      )
    : null

  const deleteDialog = (
    <AlertDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open && !removingId) setPendingDelete(null)
      }}
    >
      <AlertDialogPortal>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notes.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('notes.deleteDescription')}</AlertDialogDescription>
            {error ? <span role="alert">{error}</span> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(removingId)}>
              {t('notes.cancel')}
            </AlertDialogCancel>
            <Button
              variant="danger"
              loading={Boolean(removingId)}
              onClick={() => void confirmRemove()}
            >
              {t('notes.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  )

  const generationError = generation.error ? (
    <Alert
      tone="error"
      layout="stacked"
      title={t('generation.failed')}
      description={t('generation.failureDescription')}
      action={
        generation.diagnostic ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" variant="secondary">
                {t('generation.diagnostics')}
              </Button>
            </DialogTrigger>
            <DialogPortal>
              <DialogContent className="!flex max-h-[calc(100dvh-var(--vds-space-8))] !flex-col !overflow-hidden">
                <DialogHeader>
                  <DialogTitle>{t('generation.diagnostics')}</DialogTitle>
                </DialogHeader>
                <ScrollArea
                  className="min-h-0 max-h-[var(--vds-dialog-list-max-height)] flex-1"
                  viewportClassName="pr-[var(--vds-space-2)]"
                >
                  <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {generation.diagnostic}
                  </div>
                </ScrollArea>
              </DialogContent>
            </DialogPortal>
          </Dialog>
        ) : undefined
      }
    />
  ) : null

  const preview = generation.preview?.blocks.length ? (
    <section
      data-testid="note-generation-preview"
      data-preview-revision={generation.preview.revision}
      className="min-w-0 rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]"
      aria-label={t('generation.preview')}
    >
      <div
        role="status"
        className="mb-[var(--vds-space-3)] flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
      >
        {generation.pending ? <Spinner size="sm" aria-hidden="true" /> : null}
        <span>
          {generation.error
            ? t('generation.previewFailed')
            : generation.preview.status === 'generated'
              ? t('generation.validating')
              : t('generation.preview')}
        </span>
      </div>
      {generation.preview.blocks.map((block) => (
        <Markdown
          key={block.id}
          math
          text={
            block.kind === 'heading1'
              ? `# ${block.text}`
              : block.kind === 'heading2'
                ? `## ${block.text}`
                : block.text
          }
        />
      ))}
    </section>
  ) : null

  if (draft) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-[var(--vds-space-2)] p-[var(--vds-space-3)]">
        {headerExport}
        {generationError}
        <NoteSources itemId={itemId} text={draft.text} provenance={selected?.provenance}>
          {(sources) => (
            <NoteEditor
              key={selectedId ?? 'new'}
              initialMode={generation.note?.id === selectedId ? 'preview' : 'edit'}
              sources={sources}
              navigation={
                <Button
                  className={reader ? '!px-0' : '!px-0 !text-[var(--vds-brand-text-primary)]'}
                  size="sm"
                  variant="ghost"
                  icon={<ArrowLeft size={14} />}
                  disabled={Boolean(removingId)}
                  onClick={requestClose}
                >
                  {t(reader ? 'readerNotes.back' : 'notes.back')}
                </Button>
              }
              stackedHeader={Boolean(reader)}
              actions={
                <>
                  {selected && !isNew ? <NoteIndex note={selected} /> : null}
                  {!reader && !isNew && selected ? (
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
                  ) : null}
                </>
              }
              draft={draft}
              disabled={Boolean(removingId)}
              error={error || exportError || undefined}
              status={status}
              titlePlaceholder={t('notes.defaultTitleHint')}
              onExport={reader?.headerActionsHost ? undefined : exportSelected}
              onTextChange={setText}
              onTitleChange={setTitle}
              onRetry={error && status === 'dirty' ? () => void flush() : undefined}
            />
          )}
        </NoteSources>
        {reader ? (
          <div className="flex shrink-0 items-stretch gap-[var(--vds-space-2)] border-t border-[var(--vds-border-default)] pt-[var(--vds-space-2)]">
            {reader.annotationAction?.()}
            <Button
              className="min-h-[var(--vds-control-height-sm)] min-w-0 flex-1 !whitespace-normal"
              size="content"
              variant="primary"
              disabled={status !== 'dirty' || (isNew && !draft.title.trim() && !draft.text.trim())}
              loading={status === 'saving'}
              onClick={() => void flush()}
            >
              {t('notes.save')}
            </Button>
          </div>
        ) : null}
        {deleteDialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {headerExport}
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-3)] p-[var(--vds-space-3)]">
        {generationError}
        {!reader || sortedNotes.length || generation.pending || preview ? (
          <div className="flex shrink-0 items-center justify-between gap-[var(--vds-space-2)]">
            {!reader || sortedNotes.length ? (
              <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                {t('notes.count', { count: sortedNotes.length })}
              </span>
            ) : (
              <span />
            )}
            {reader?.annotationAction?.(requestNew) ?? (
              <Button size="sm" variant="primary" onClick={requestNew}>
                {t('relations.addNote')}
              </Button>
            )}
          </div>
        ) : null}
        {error || exportError ? (
          <Alert
            tone="error"
            title={t('notes.operationFailed')}
            description={error || exportError}
          />
        ) : null}

        {reader && generation.pending && !sortedNotes.length && !preview ? (
          <div
            role="status"
            data-testid="note-generation-pending"
            className="flex flex-1 flex-col items-center justify-center gap-[var(--vds-space-3)] text-center font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]"
          >
            <Spinner size="sm" aria-hidden="true" />
            <p>{t('generation.pending', { count: generation.count })}</p>
          </div>
        ) : sortedNotes.length || generation.pending || preview ? (
          <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full">
            <div className="flex flex-col gap-[var(--vds-space-2)]">
              {preview}
              {generation.pending && !preview ? (
                <div
                  role="status"
                  className={NOTE_CARD_CLASS}
                  data-testid="note-generation-pending"
                >
                  <div className="min-w-0 flex-1 border border-transparent p-[var(--vds-space-3)] text-left [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    <EllipsisText tooltipPortalled wrapperClassName={NOTE_CARD_TITLE_CLASS}>
                      {t('generation.pendingTitle')}
                    </EllipsisText>
                    <span className={NOTE_CARD_SUMMARY_CLASS}>
                      {t('generation.pending', { count: generation.count })}
                    </span>
                  </div>
                  <span
                    className={`${NOTE_CARD_TRAILING_CLASS} grid size-[var(--vds-control-height-sm)] place-items-center`}
                  >
                    <Spinner size="sm" aria-hidden="true" />
                  </span>
                </div>
              ) : null}
              {sortedNotes.map((note, index) => (
                <div
                  key={note.id}
                  className={`group/note-row ${NOTE_CARD_CLASS} hover:bg-[var(--vds-surface-hover)] focus-within:bg-[var(--vds-surface-hover)]`}
                >
                  <Button
                    className="h-auto min-w-0 flex-1 items-start justify-start gap-[var(--vds-space-2)] !bg-transparent !px-[var(--vds-space-3)] !py-[var(--vds-space-3)] !text-[length:var(--vds-font-body-lv2)] hover:!bg-transparent"
                    variant="ghost"
                    onClick={() => requestOpen(note)}
                  >
                    <span className="min-w-0 flex-1 text-left">
                      <EllipsisText tooltipPortalled wrapperClassName={NOTE_CARD_TITLE_CLASS}>
                        {noteTitle(note, index)}
                      </EllipsisText>
                      <span className={NOTE_CARD_SUMMARY_CLASS}>
                        {literatureNoteSummary(note) || t('notes.emptySummary')}
                      </span>
                    </span>
                  </Button>
                  <IconButton
                    className="mt-[var(--vds-space-2)] shrink-0"
                    icon={<Download size={14} />}
                    label={t('notes.exportNamed', { title: noteTitle(note, index) })}
                    size="sm"
                    variant="ghostIcon"
                    onClick={() => exportListed(note, index)}
                  />
                  <IconButton
                    className={`${NOTE_CARD_TRAILING_CLASS} hover:!text-[var(--vds-error-text-primary)]`}
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
            variant={reader ? 'panel' : 'compact'}
            className="flex-1 content-center"
            icon={reader ? <BookText /> : undefined}
            iconTone={reader ? 'subtle' : undefined}
            action={
              reader
                ? (reader.annotationAction?.(requestNew) ?? (
                    <Button size="sm" variant="primary" onClick={requestNew}>
                      {t('relations.addNote')}
                    </Button>
                  ))
                : undefined
            }
            description={t(reader ? 'readerNotes.emptyDescription' : 'notes.emptyDescription')}
            title={t('notes.emptyTitle')}
          />
        )}
      </div>

      {deleteDialog}
    </div>
  )
}
