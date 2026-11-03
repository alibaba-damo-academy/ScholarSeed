import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button } from '../../../components/ui'
import { selectionViewport, useWorkspaceController } from '../workspace'
import { DOCUMENT_READERS, type DocumentReader } from './document'
import { textDrag } from './drag'
import { previewFormat } from './routing'
import { textSelection, type PreviewSelection } from './selection'
import { Workbook } from './Workbook'

interface Props {
  bytes: Uint8Array
  title: string
  revision: string
  tabId?: string
}

const INITIAL_ZOOM = 100

export function Preview({ bytes, title, revision, tabId }: Props): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const controller = useWorkspaceController()
  const root = useRef<HTMLDivElement>(null)
  const reader = useRef<DocumentReader | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const format = previewFormat(title)
  const onSelection = useCallback((selected: PreviewSelection | null): void => {
    if (!tabId) return
    const state = controller.getSnapshot()
    const tab = state.tabs[tabId]
    const session = tab ? state.sessions[tab.sessionId] : undefined
    if (!session || session.revision !== revision || tab.viewKind !== 'preview') return
    const bounds = root.current?.getBoundingClientRect()
    const point = selected && bounds ? {
      x: Math.max(bounds.left + 1, Math.min(bounds.right - 1, selected.rect.right)),
      y: Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, selected.rect.bottom))
    } : undefined
    controller.setSelection(tabId, selected ? {
      document_id: session.documentId,
      document_session_id: session.id,
      revision,
      status: 'exact',
      text: selected.text,
      locator: selected.locator
    } : null, selected ? selectionViewport(selected.rect, point) : undefined)
  }, [controller, revision, tabId])

  useEffect(() => {
    let active = true
    let mounted: DocumentReader | null = null
    setFailed(false); setLoading(format !== 'xlsx')
    onSelection(null)
    const target = root.current
    if (target && (format === 'docx' || format === 'pptx')) {
      // Each asynchronous load owns a detached root; stale loads can never overwrite a new revision.
      const content = document.createElement('div')
      if (format === 'docx') content.className = 'min-w-max'
      target.replaceChildren(content)
      // React reuses this viewport when opening another file or history revision.
      // A new reader must not inherit the previous document's scroll offset.
      target.scrollTop = 0
      target.scrollLeft = 0
      void DOCUMENT_READERS[format](bytes, content).then((result) => {
        if (!active) { result.dispose(); return }
        mounted = result
        reader.current = result
        void Promise.resolve(result.zoom(INITIAL_ZOOM)).catch(() => { if (active) setFailed(true) })
        setLoading(false)
      }, () => { if (active) { setFailed(true); setLoading(false) } })
    }
    return () => { active = false; mounted?.dispose(); reader.current = null; onSelection(null) }
  }, [bytes, revision, format, attempt, onSelection])

  const publishText = useCallback((): void => {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !root.current?.contains(selection.anchorNode)) return
    onSelection(textSelection(selection.getRangeAt(0), reader.current?.anchors() ?? []))
  }, [onSelection])
  useEffect(() => {
    if (!root.current) return
    return textDrag(root.current, () => onSelection(null), publishText)
  }, [onSelection, format, publishText])
  return <div
    className="flex h-full min-h-0 flex-1 flex-col bg-[var(--vds-bg-app)]"
    data-testid="office-preview"
    data-office-format={format}
    data-office-title={title}
    data-office-revision={revision}
  >
    {loading && <div className="p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]" role="status">{t('officePreview.loading')}</div>}
    {failed && <div className="p-[var(--vds-space-4)]"><Alert tone="warning" title={t('officePreview.failed')} /><Button onClick={() => setAttempt((value) => value + 1)}>{t('officePreview.retry')}</Button></div>}
    {format === 'xlsx' ? <Workbook key={`${revision}:${attempt}`} bytes={bytes} title={title} zoom={INITIAL_ZOOM} query="" searchStep={0} onSearch={() => undefined} onSelection={onSelection} /> : <div ref={root} tabIndex={0} data-testid="office-preview-content" className="min-h-0 flex-1 select-text overflow-auto p-[var(--vds-space-4)]" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        const anchors = reader.current?.anchors() ?? []
        const first = anchors[0]?.element
        const last = anchors.at(-1)?.fragments?.at(-1) ?? anchors.at(-1)?.element
        if (!first || !last) return
        event.preventDefault(); event.stopPropagation()
        const range = document.createRange()
        range.setStart(first, 0); range.setEnd(last, last.childNodes.length)
        window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
      }
    }} onKeyUp={publishText} />}
  </div>
}
