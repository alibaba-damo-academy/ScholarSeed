import { FileText, Plus, Trash } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EmptyState,
  IconButton,
  Input,
  ScrollArea,
  Textarea
} from '../../components/ui'
import type { LiteratureNote } from '../../contracts/literature'
import {
  LiteratureApiError,
  addLiteratureNote,
  deleteLiteratureNote,
  updateLiteratureNote
} from './api'

const NOTE_VERSION_CONFLICT = 'literature_note_version_conflict'
const NEW_NOTE = '__new__'

interface NoteDraft {
  title: string
  text: string
  version: number
}

interface LiteratureNotesProps {
  itemId: string
  notes: LiteratureNote[]
  onReload: () => Promise<void>
}

function draftOf(note: LiteratureNote): NoteDraft {
  return { title: note.title, text: note.text, version: note.version }
}

export function LiteratureNotes({
  itemId,
  notes,
  onReload
}: LiteratureNotesProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [selectedId, setSelectedId] = useState<string | null>(notes[0]?.id ?? null)
  const [draft, setDraft] = useState<NoteDraft | null>(notes[0] ? draftOf(notes[0]) : null)
  const [isNew, setIsNew] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const selected = notes.find((note) => note.id === selectedId) ?? null

  useEffect(() => {
    if (isNew || dirty) return
    const current = notes.find((note) => note.id === selectedId) ?? notes[0] ?? null
    setSelectedId(current?.id ?? null)
    setDraft(current ? draftOf(current) : null)
  }, [dirty, isNew, notes, selectedId])

  const select = (identity: string): void => {
    if (identity === NEW_NOTE) {
      setSelectedId(null)
      setDraft({ title: '', text: '', version: 1 })
      setIsNew(true)
    } else {
      const note = notes.find((candidate) => candidate.id === identity)
      if (!note) return
      setSelectedId(note.id)
      setDraft(draftOf(note))
      setIsNew(false)
    }
    setDirty(false)
    setError('')
  }

  const requestSelection = (identity: string): void => {
    if (dirty) {
      setPendingSelection(identity)
      return
    }
    select(identity)
  }

  const cancel = (): void => {
    if (isNew) {
      select(notes[0]?.id ?? '')
      if (!notes.length) {
        setSelectedId(null)
        setDraft(null)
      }
      return
    }
    if (selected) setDraft(draftOf(selected))
    setDirty(false)
    setError('')
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.text.trim()) {
      setError(t('notes.bodyRequired'))
      return
    }
    setSaving(true)
    setError('')
    try {
      const note = isNew
        ? await addLiteratureNote(itemId, draft.text, draft.title)
        : await updateLiteratureNote(itemId, selectedId ?? '', draft)
      setSelectedId(note.id)
      setDraft(draftOf(note))
      setIsNew(false)
      setDirty(false)
      await onReload()
    } catch (reason) {
      if (
        reason instanceof LiteratureApiError &&
        reason.failure.code === NOTE_VERSION_CONFLICT
      ) {
        setError(t('notes.versionConflict'))
      } else {
        setError(reason instanceof Error ? reason.message : t('notes.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    setError('')
    try {
      await deleteLiteratureNote(itemId, selectedId)
      setSelectedId(null)
      setDraft(null)
      setDirty(false)
      await onReload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('notes.deleteFailed'))
    } finally {
      setSaving(false)
      setDeleteOpen(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-[var(--vds-space-3)] p-[var(--vds-space-3)]">
      <Button
        className="self-start"
        icon={<Plus size={16} />}
        variant="secondary"
        onClick={() => requestSelection(NEW_NOTE)}
      >
        {t('relations.addNote')}
      </Button>

      {notes.length ? (
        <ScrollArea className="max-h-32 shrink-0">
          <div className="grid gap-[var(--vds-space-1)] pr-[var(--vds-space-2)]">
            {notes.map((note) => (
              <Button
                key={note.id}
                aria-pressed={!isNew && note.id === selectedId}
                className="w-full justify-start truncate"
                size="sm"
                variant={!isNew && note.id === selectedId ? 'secondary' : 'ghost'}
                onClick={() => requestSelection(note.id)}
              >
                {note.title}
              </Button>
            ))}
          </div>
        </ScrollArea>
      ) : !isNew ? (
        <EmptyState
          action={(
            <Button variant="secondary" onClick={() => select(NEW_NOTE)}>
              {t('relations.addNote')}
            </Button>
          )}
          description={t('notes.emptyDescription')}
          icon={<FileText size={18} />}
          title={t('notes.emptyTitle')}
        />
      ) : null}

      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-3)]">
          <Input
            label={t('notes.title')}
            placeholder={isNew ? t('notes.defaultTitleHint') : undefined}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value })
              setDirty(true)
            }}
          />
          <Textarea
            className="min-h-40 flex-1 resize-none"
            error={error || undefined}
            label={t('relations.noteContent')}
            placeholder={t('notes.bodyPlaceholder')}
            value={draft.text}
            onChange={(event) => {
              setDraft({ ...draft, text: event.target.value })
              setDirty(true)
              if (error) setError('')
            }}
          />
          <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
            {!isNew && selected ? (
              <IconButton
                icon={<Trash size={14} />}
                label={t('notes.deleteNamed', { title: selected.title })}
                size="sm"
                variant="ghostIcon"
                onClick={() => setDeleteOpen(true)}
              />
            ) : <span />}
            <div className="flex gap-[var(--vds-space-2)]">
              {(isNew || dirty) ? (
                <Button disabled={saving} variant="outline" onClick={cancel}>
                  {t('notes.cancel')}
                </Button>
              ) : null}
              <Button disabled={!dirty && !isNew} loading={saving} onClick={() => void save()}>
                {t('notes.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <AlertDialog open={pendingSelection !== null} onOpenChange={(open) => {
        if (!open) setPendingSelection(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notes.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('notes.discardDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('notes.keepEditing')}</AlertDialogCancel>
            <Button variant="danger" onClick={() => {
              const next = pendingSelection
              setPendingSelection(null)
              if (next) select(next)
            }}>
              {t('notes.discard')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('notes.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('notes.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('notes.cancel')}</AlertDialogCancel>
            <Button loading={saving} variant="danger" onClick={() => void remove()}>
              {t('notes.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && !draft ? <Alert tone="error" title={t('notes.operationFailed')} description={error} /> : null}
    </div>
  )
}
