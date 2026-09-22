import React, { useEffect, useState } from 'react'

import { useApp } from '../../store'
import { languageFor } from './language'
import { MonacoFrame } from './monaco/host'
import type { MonacoFrameContext } from './monaco/contract'

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
  const { state } = useApp()
  const [frame, setFrame] = useState<MonacoFrameContext | null>(null)

  useEffect(() => {
    const host = frame?.host
    if (!host) return
    const { monaco } = frame.runtime
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
  }, [baseText, candidateText, frame, identity, onCandidateChange, path, readOnly])

  return (
    <MonacoFrame
      language={state.lang}
      onReady={setFrame}
      testId={testId}
      theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
    />
  )
}
