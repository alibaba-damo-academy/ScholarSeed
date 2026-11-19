import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, useToast } from '../../components/ui'
import type { ViewerKind } from '../../contracts/workbench'
import { CsvDocument } from './csv/Document'
import { DocumentFallbackActions } from './External'
import { Preview } from './preview/Preview'
import { previewFormat, usesCsvDocument } from './preview/routing'
import { useDocumentWorkspace, type DocumentViewKind, type DocumentSession } from './workspace'

export interface OfficeViewBinding {
  bytes: Uint8Array
  revision: string
  title: string
  viewId: string
  viewer: ViewerKind
  processor: string | null
}

export function OfficeSnapshot({ binding }: { binding: OfficeViewBinding }): React.JSX.Element {
  if (usesCsvDocument(binding.title))
    return <CsvDocument bytes={binding.bytes} title={binding.title} revision={binding.revision} />
  if (previewFormat(binding.title))
    return <Preview bytes={binding.bytes} title={binding.title} revision={binding.revision} />
  return <OfficeSnapshotExport binding={binding} />
}

function OfficeSnapshotExport({ binding }: { binding: OfficeViewBinding }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.scholarseed.saveFileCopy({
        bytes: binding.bytes,
        suggestedName: binding.title,
      })
      if (!result.ok && !result.canceled) toast({ title: t('dock.openFailed'), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="grid h-full min-h-0 place-items-center overflow-auto bg-[var(--vds-bg-page)] p-[var(--vds-space-6)]"
      data-testid="office-unavailable"
    >
      <div className="flex max-w-[var(--vds-modal-width-sm)] flex-col items-center gap-[var(--vds-space-3)] text-center">
        <strong className="text-[length:var(--vds-font-title)] text-[var(--vds-text-primary)]">
          {t('officeDocument.unavailableTitle')}
        </strong>
        <p className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {t('officeDocument.unavailableDetail')}
        </p>
        <Button disabled={busy} loading={busy} variant="outline" onClick={() => void save()}>
          {t('dock.saveAsExternal')}
        </Button>
      </div>
    </div>
  )
}

export function OfficeDocument(props: {
  kind: 'office' | 'spreadsheet'
  sessionId: string
  tabId: string
  viewKind: DocumentViewKind
}): React.JSX.Element {
  const workspace = useDocumentWorkspace()
  const session = workspace.sessions[props.sessionId]
  if (session && usesCsvDocument(session.source.path))
    return (
      <CsvDocument
        bytes={session.bytes}
        title={session.source.path.split('/').pop() || session.title}
        revision={session.revision}
        sessionId={props.sessionId}
        tabId={props.tabId}
        viewKind={props.viewKind}
      />
    )
  if (session && previewFormat(session.source.path))
    return (
      <Preview
        bytes={session.bytes}
        title={session.source.path.split('/').pop() || session.title}
        revision={session.revision}
        tabId={props.tabId}
      />
    )
  return session ? <UnavailableOfficeDocument session={session} /> : <></>
}

function UnavailableOfficeDocument({ session }: { session: DocumentSession }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <div
      className="grid h-full min-h-0 place-items-center overflow-auto bg-[var(--vds-bg-page)] p-[var(--vds-space-6)]"
      data-testid="office-unavailable"
    >
      <div className="flex max-w-[var(--vds-modal-width-sm)] flex-col items-center gap-[var(--vds-space-3)] text-center">
        <strong className="text-[length:var(--vds-font-title)] text-[var(--vds-text-primary)]">
          {t('officeDocument.unavailableTitle')}
        </strong>
        <p className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {t('officeDocument.unavailableDetail')}
        </p>
        <DocumentFallbackActions session={session} />
      </div>
    </div>
  )
}
