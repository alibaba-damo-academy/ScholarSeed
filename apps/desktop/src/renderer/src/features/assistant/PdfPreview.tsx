import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getDocument, GlobalWorkerOptions, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { Button, Spinner } from '../../components/ui'
import type { SessionArtifact } from '../../model'
import { isDocumentLoadFailure, loadDocument } from '../workbench/api'
import { sha256Bytes } from './anchors'
import { eligiblePdf } from './delivery'

const THUMBNAIL_SCALE = 0.5
const HASH_PREFIX = 'sha256:'
GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export function GeneratedPdf({
  sessionId,
  artifact,
  onOpen,
  large = true,
}: {
  sessionId: string
  artifact: SessionArtifact
  onOpen: () => void
  large?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('assistant')
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const supported = eligiblePdf(artifact)

  useEffect(() => {
    if (!supported) return
    let active = true
    let render: RenderTask | undefined
    let dispose: (() => Promise<void>) | undefined
    setState('loading')
    void (async () => {
      const loaded = await loadDocument({
        kind: 'session-artifact',
        sessionId,
        artifactId: artifact.artifact_id,
        path: artifact.path,
        mediaType: artifact.media_type,
      })
      if (
        isDocumentLoadFailure(loaded) ||
        loaded.viewer !== 'pdf' ||
        !loaded.capabilities.can_preview
      )
        throw new Error('PDF preview unavailable')
      if (artifact.sha256) {
        const expected = artifact.sha256.startsWith(HASH_PREFIX)
          ? artifact.sha256
          : HASH_PREFIX + artifact.sha256
        if ((await sha256Bytes(loaded.bytes)) !== expected) throw new Error('PDF revision changed')
      }
      if (!active) return
      const task = getDocument({ data: new Uint8Array(loaded.bytes) })
      dispose = () => task.destroy()
      const document = await task.promise
      const page = await document.getPage(1)
      if (!active || !canvas.current) return
      const viewport = page.getViewport({ scale: THUMBNAIL_SCALE })
      const target = canvas.current
      target.width = Math.ceil(viewport.width)
      target.height = Math.ceil(viewport.height)
      const context = target.getContext('2d')
      if (!context) throw new Error('PDF canvas unavailable')
      render = page.render({ canvas: target, canvasContext: context, viewport })
      await render.promise
      if (active) setState('ready')
    })().catch(() => {
      if (active) setState('failed')
    })
    return () => {
      active = false
      render?.cancel()
      void dispose?.()
    }
  }, [
    supported,
    sessionId,
    artifact.artifact_id,
    artifact.path,
    artifact.media_type,
    artifact.sha256,
  ])

  if (!supported) return null
  return (
    <Button
      unstyled
      onClick={onOpen}
      aria-label={t('artifactEntry.openName', { name: artifact.name })}
      className={
        large
          ? 'flex max-h-[var(--vds-preview-content-max-height)] w-full items-center justify-center overflow-hidden rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-muted)]'
          : 'flex aspect-square w-full items-center justify-center overflow-hidden rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-muted)]'
      }
    >
      {state === 'loading' && <Spinner />}
      {state === 'failed' && <span role="status">{t('artifactEntry.readFailed')}</span>}
      <canvas
        ref={canvas}
        hidden={state !== 'ready'}
        className={
          large
            ? 'max-h-[var(--vds-preview-content-max-height)] max-w-full object-contain'
            : 'h-full w-full object-contain'
        }
      />
    </Button>
  )
}
