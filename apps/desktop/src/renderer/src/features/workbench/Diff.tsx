import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert } from '../../components/ui/Alert'
import { languageFor } from './language'
import { monaco } from './monaco'
import { MONACO_LANGUAGE } from './nls'

interface DiffProps {
  baseText: string
  candidateText: string
  identity: string
  path: string
  readOnly: boolean
  testId: string
  onCandidateChange?: (text: string) => void
}

export function Diff({
  baseText,
  candidateText,
  identity,
  path,
  readOnly,
  testId,
  onCandidateChange
}: DiffProps): React.JSX.Element {
  const { t, i18n } = useTranslation('workbench')
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const language = languageFor(path)
    const original = monaco.editor.createModel(
      baseText,
      language,
      monaco.Uri.parse(`inmemory://scholarseed-diff/${encodeURIComponent(identity)}/base`)
    )
    const modified = monaco.editor.createModel(
      candidateText,
      language,
      monaco.Uri.parse(`inmemory://scholarseed-diff/${encodeURIComponent(identity)}/candidate`)
    )
    const editor = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      minimap: { enabled: false },
      originalEditable: false,
      readOnly,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      lineHeight: 20
    })
    editor.setModel({ original, modified })
    const listener = onCandidateChange
      ? modified.onDidChangeContent(() => onCandidateChange(modified.getValue()))
      : null
    return () => {
      listener?.dispose()
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [baseText, candidateText, identity, onCandidateChange, path, readOnly])

  return <>
    {i18n.resolvedLanguage !== MONACO_LANGUAGE && <Alert tone="info" title={t('code.languagePending')} />}
    <div className="min-h-0 flex-1" data-testid={testId} ref={hostRef} />
  </>
}
