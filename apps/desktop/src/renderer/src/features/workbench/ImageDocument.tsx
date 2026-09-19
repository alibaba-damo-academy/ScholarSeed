import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Spinner } from '../../components/ui'
import {
  fitImage,
  imageMediaType,
  imageViewState,
  panImage,
  zoomImage,
  IMAGE_MAX_SCALE,
  IMAGE_MIN_SCALE,
  IMAGE_PERCENT,
  IMAGE_ZOOM_FACTOR,
  type ImageSize,
  type ImageViewState
} from './image'
import { useDocumentWorkspace, useWorkspaceController } from './workspace'
import './image.css'

const EMPTY_SIZE: ImageSize = { width: 0, height: 0 }
const PRIMARY_POINTER_BUTTON = 0

export function ImageDocument({ sessionId, tabId }: { sessionId: string; tabId: string }): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const session = workspace.sessions[sessionId]
  const tab = workspace.tabs[tabId]
  const viewportRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; view: ImageViewState } | null>(null)
  const [url, setUrl] = useState('')
  const [natural, setNatural] = useState<ImageSize>(EMPTY_SIZE)
  const [viewport, setViewport] = useState<ImageSize>(EMPTY_SIZE)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const savedView = imageViewState(tab?.viewState)
  const view = savedView.mode === 'fit' ? fitImage(natural, viewport) : savedView
  const ready = natural.width > 0 && natural.height > 0 && !failed

  useEffect(() => {
    setNatural(EMPTY_SIZE)
    setFailed(false)
    if (!session || session.loadState !== 'ready') {
      setUrl('')
      return
    }
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(session.bytes)], { type: imageMediaType(session.source.path, session.mediaType) }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [session?.bytes, session?.mediaType, session?.loadState, session?.source.path])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const saveView = (next: ImageViewState): void => controller.setTabViewState(tabId, { ...next })
  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="vds-image-document" data-testid="image-viewer">
      <div className="vds-image-toolbar" role="toolbar" aria-label={t('image.toolbar')}>
        <Button variant="ghost" size="sm" aria-label={t('image.zoomOut')} disabled={!ready || view.scale <= IMAGE_MIN_SCALE} onClick={() => saveView(zoomImage(view, view.scale / IMAGE_ZOOM_FACTOR))}>−</Button>
        <output data-testid="image-zoom" aria-label={t('image.zoom')}>{Math.round(view.scale * IMAGE_PERCENT)}%</output>
        <Button variant="ghost" size="sm" aria-label={t('image.zoomIn')} disabled={!ready || view.scale >= IMAGE_MAX_SCALE} onClick={() => saveView(zoomImage(view, view.scale * IMAGE_ZOOM_FACTOR))}>+</Button>
        <Button variant="ghost" size="sm" disabled={!ready} aria-pressed={view.mode === 'fit'} onClick={() => saveView(fitImage(natural, viewport))}>{t('image.fit')}</Button>
        <Button variant="ghost" size="sm" disabled={!ready} onClick={() => saveView({ mode: 'manual', scale: 1, x: 0, y: 0 })}>{t('image.actual')}</Button>
        {ready && <span data-testid="image-dimensions">{natural.width} × {natural.height}</span>}
        <span>{t('image.readonly')}</span>
      </div>
      <div
        ref={viewportRef}
        className="vds-image-viewport"
        data-testid="image-viewport"
        data-scale={view.scale}
        data-pan-x={view.x}
        data-pan-y={view.y}
        data-mode={view.mode}
        data-dragging={dragging}
        onPointerDown={(event) => {
          if (!ready || event.button !== PRIMARY_POINTER_BUTTON || drag.current) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start?.pointerId === event.pointerId) saveView(panImage(start.view, event.clientX - start.x, event.clientY - start.y))
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
      >
        {url && !failed && (
          <img
            key={url}
            src={url}
            alt={session?.title || t('viewer.image')}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              if (width > 0 && height > 0) setNatural({ width, height })
              else setFailed(true)
            }}
            onError={() => setFailed(true)}
            style={{
              width: natural.width || undefined,
              height: natural.height || undefined,
              visibility: ready ? 'visible' : 'hidden',
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`
            }}
          />
        )}
        {(failed || !session || session.loadState === 'error')
          ? <span role="alert">{t('image.error')}</span>
          : !ready && <Spinner aria-label={t('image.loading')} />}
      </div>
    </div>
  )
}
