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
  onSplitPositionChange?: (left: number) => void
}

export function Diff({
  baseText,
  candidateText,
  identity,
  path,
  readOnly,
  testId,
  onCandidateChange,
  onSplitPositionChange
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
      // Version and review headers label the original and modified columns.
      useInlineViewWhenSpaceIsLimited: false,
      scrollBeyondLastLine: false,
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      lineHeight: 20
    })
    editor.setModel({ original, modified })
    const frameWindow = host.ownerDocument.defaultView!
    let layoutFrame: number | null = null
    const reportLayout = (): void => {
      if (!onSplitPositionChange || layoutFrame !== null) return
      // Both panes finish their layout before reading the modified pane's origin.
      layoutFrame = frameWindow.requestAnimationFrame(() => {
        layoutFrame = null
        const modifiedNode = editor.getModifiedEditor().getDomNode()
        if (modifiedNode) {
          onSplitPositionChange(modifiedNode.getBoundingClientRect().left - host.getBoundingClientRect().left)
        }
      })
    }
    const layoutListeners = onSplitPositionChange ? [
      editor.getOriginalEditor().onDidLayoutChange(reportLayout),
      editor.getModifiedEditor().onDidLayoutChange(reportLayout)
    ] : []
    reportLayout()
    const listener = onCandidateChange
      ? modified.onDidChangeContent(() => onCandidateChange(modified.getValue()))
      : null
    return () => {
      if (layoutFrame !== null) frameWindow.cancelAnimationFrame(layoutFrame)
      layoutListeners.forEach((layoutListener) => layoutListener.dispose())
      listener?.dispose()
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [baseText, frame, identity, onCandidateChange, onSplitPositionChange, path, readOnly])

  return (
    <MonacoFrame
      language={state.lang}
      onReady={setFrame}
      testId={testId}
      theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
    />
  )
}
