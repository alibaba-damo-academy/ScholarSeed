import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button } from '../../components/ui'
import type { LiteratureNote } from '../../contracts/literature'

export function NoteIndex({ note }: { note: LiteratureNote }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [error, setError] = useState(false)
  const exportIndex = async (): Promise<void> => {
    setError(false)
    try {
      if (!window.scholarseed) throw new Error('save bridge unavailable')
      const result = await window.scholarseed.saveFileCopy({
        suggestedName: 'note-index.json',
        bytes: new TextEncoder().encode(JSON.stringify(note.provenance, null, 2)),
      })
      if (!result.ok && !result.canceled) throw new Error('index export failed')
    } catch {
      setError(true)
    }
  }
  return (
    <>
      {note.provenance?.status === 'indexed' ? (
        <Button size="sm" variant="ghost" onClick={() => void exportIndex()}>
          {t('noteSources.exportIndex')}
        </Button>
      ) : null}
      {error ? <Alert tone="error">{t('notes.exportFailed')}</Alert> : null}
    </>
  )
}
