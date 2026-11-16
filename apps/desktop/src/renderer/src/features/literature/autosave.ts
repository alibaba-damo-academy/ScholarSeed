import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import type { LiteratureNote } from '../../contracts/literature'
import {
  LiteratureApiError,
  addLiteratureNote,
  deleteLiteratureNote,
  updateLiteratureNote,
} from './api'
import { catalogue } from './catalog'
import { NoteEditingSession, type NoteEditorError } from './editor'
import { LITERATURE_NOTES_CHANGED } from './note'

const NOTE_VERSION_CONFLICT = 'literature_note_version_conflict'

interface NoteAutoSaveOptions {
  itemId: string
  notes: LiteratureNote[]
}

export function useNoteAutoSave({ itemId, notes }: NoteAutoSaveOptions) {
  const { t } = useTranslation('literature')
  const messages: Record<NoteEditorError, string> = {
    saveFailed: t('notes.saveFailed'),
    versionConflict: t('notes.versionConflict'),
    deleteFailed: t('notes.deleteFailed'),
  }
  const session = catalogue.noteEditor(
    itemId,
    (onUnused) =>
      new NoteEditingSession(
        {
          create: (draft) => addLiteratureNote(itemId, draft.text, draft.title),
          update: (id, draft) => updateLiteratureNote(itemId, id, draft),
          remove: (id) => deleteLiteratureNote(itemId, id),
          changed: () => {
            window.dispatchEvent(new CustomEvent(LITERATURE_NOTES_CHANGED, { detail: itemId }))
            catalogue.reload()
          },
          saveError: (reason) =>
            reason instanceof LiteratureApiError && reason.failure.code === NOTE_VERSION_CONFLICT
              ? 'versionConflict'
              : 'saveFailed',
        },
        onUnused
      )
  )
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)

  useEffect(() => session.sync(notes), [notes, session])

  return {
    ...snapshot,
    error: snapshot.errorCode ? messages[snapshot.errorCode] : '',
    requestOpen: session.requestOpen,
    requestNew: session.requestNew,
    requestClose: session.requestClose,
    setTitle: session.setTitle,
    setText: session.setText,
    flush: session.flush,
    remove: session.remove,
  }
}
