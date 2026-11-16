import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Spinner } from '../../components/ui'
import type { DocumentPanelContext, DocumentPanelPresentation } from '../../contracts/features'
import type { LiteratureNote } from '../../contracts/literature'
import { LiteratureNotes as SharedLiteratureNotes } from './Notes'
import { listLiteratureNotes } from './api'
import { catalogue } from './catalog'
import { literatureIdFromDocument } from './note'

interface NotesState {
  loading: boolean
  failed: boolean
  notes: LiteratureNote[]
}

const INITIAL_STATE: NotesState = { loading: true, failed: false, notes: [] }

export function LiteratureNotesTitle(): React.JSX.Element {
  const { t } = useTranslation('literature')
  return <>{t('detail.tabs.notes')}</>
}

export function LiteratureNotesPanel({
  context,
  presentation,
}: {
  context: DocumentPanelContext
  presentation?: DocumentPanelPresentation
}): React.JSX.Element | null {
  const literatureId = literatureIdFromDocument(context)
  return literatureId ? (
    <LiteratureNotesPanelContent
      key={literatureId}
      itemId={literatureId}
      presentation={presentation}
    />
  ) : null
}

function LiteratureNotesPanelContent({
  itemId,
  presentation,
}: {
  itemId: string
  presentation?: DocumentPanelPresentation
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [state, setState] = useState<NotesState>(INITIAL_STATE)
  const [retryRevision, setRetryRevision] = useState(0)
  const retainedDraft = catalogue.noteEditorSnapshot(itemId)?.draft

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

  if (state.loading && !retainedDraft) {
    return (
      <div
        className="grid h-full min-h-0 place-items-center text-[var(--vds-text-tertiary)]"
        role="status"
      >
        <Spinner aria-label={t('readerNotes.loading')} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--vds-surface-muted)]">
      {state.failed && (
        <div className="p-[var(--vds-space-3)]">
          <Alert
            layout="stacked"
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
      )}
      {(!state.failed || retainedDraft) && (
        <SharedLiteratureNotes
          itemId={itemId}
          notes={state.notes}
          onReload={reload}
          reader={presentation}
        />
      )}
    </div>
  )
}
