import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Spinner } from '../../components/ui'
import type { DocumentPanelContext } from '../../contracts/features'
import type { LiteratureNote } from '../../contracts/literature'
import { LiteratureNotes as SharedLiteratureNotes } from './Notes'
import { listLiteratureNotes } from './api'
import { literatureIdFromDocument } from './note'

interface NotesState {
  loading: boolean
  failed: boolean
  notes: LiteratureNote[]
}

const INITIAL_STATE: NotesState = { loading: true, failed: false, notes: [] }

export function LiteratureNotesTitle(): React.JSX.Element {
  const { t } = useTranslation('literature')
  return <>{t('readerNotes.title')}</>
}

export function LiteratureNotesPanel({
  context
}: {
  context: DocumentPanelContext
}): React.JSX.Element | null {
  const literatureId = literatureIdFromDocument(context)
  return literatureId ? <LiteratureNotesPanelContent itemId={literatureId} /> : null
}

function LiteratureNotesPanelContent({
  itemId
}: {
  itemId: string
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [state, setState] = useState<NotesState>(INITIAL_STATE)
  const [retryRevision, setRetryRevision] = useState(0)

  const reload = async (): Promise<void> => {
    try {
      const notes = await listLiteratureNotes(itemId)
      setState({ loading: false, failed: false, notes })
    } catch (reason) {
      console.error('[literature-notes] failed to load item notes', reason)
      setState((current) => ({ ...current, loading: false, failed: true }))
    }
  }

  useEffect(() => {
    let active = true
    setState(INITIAL_STATE)
    void listLiteratureNotes(itemId)
      .then((notes) => {
        if (active) setState({ loading: false, failed: false, notes })
      })
      .catch((error: unknown) => {
        console.error('[literature-notes] failed to load item notes', error)
        if (active) setState({ loading: false, failed: true, notes: [] })
      })
    return () => {
      active = false
    }
  }, [itemId, retryRevision])

  if (state.loading) {
    return (
      <div className="grid min-h-32 place-items-center" role="status">
        <Spinner aria-label={t('readerNotes.loading')} />
      </div>
    )
  }

  if (state.failed) {
    return (
      <div className="p-[var(--vds-space-3)]">
        <Alert
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRetryRevision((value) => value + 1)}
            >
              {t('readerNotes.retry')}
            </Button>
          }
          description={t('readerNotes.loadFailedDescription')}
          title={t('readerNotes.loadFailed')}
          tone="error"
        />
      </div>
    )
  }
  return (
    <SharedLiteratureNotes itemId={itemId} notes={state.notes} onReload={reload} />
  )
}
