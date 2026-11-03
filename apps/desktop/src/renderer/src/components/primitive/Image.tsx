import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Spinner } from '../ui'
import {
  fitImage,
  imageViewState,
  panImage,
  zoomImage,
  toggleImageZoom,
  IMAGE_MAX_SCALE,
  IMAGE_MIN_SCALE,
  IMAGE_PERCENT,
  IMAGE_ZOOM_FACTOR,
  type ImageSize,
  type ImageViewState,
} from './geometry'

const EMPTY_SIZE: ImageSize = { width: 0, height: 0 }
const PRIMARY_POINTER_BUTTON = 0

export function ImageView({
  url,
  title,
  failed: sourceFailed = false,
  viewState,
  onViewChange,
}: {
  url: string
  title: string
  failed?: boolean
  viewState?: Readonly<Record<string, unknown>>
  onViewChange: (next: ImageViewState) => void
}): React.JSX.Element {
  const { t: imageText } = useTranslation('workbench')
  const viewportRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; view: ImageViewState } | null>(
    null
  )
  const [natural, setNatural] = useState<ImageSize>(EMPTY_SIZE)
  const [viewport, setViewport] = useState<ImageSize>(EMPTY_SIZE)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [resource, setResource] = useState(url)
  if (resource !== url) {
    setResource(url)
    setNatural(EMPTY_SIZE)
    setFailed(false)
  }
  const savedView = imageViewState(viewState)
  const view = savedView.mode === 'fit' ? fitImage(natural, viewport) : savedView
  const ready = natural.width > 0 && natural.height > 0 && !failed && !sourceFailed

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = (): void =>
      setViewport({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const saveView = onViewChange
  useEffect(() => {
    const element = viewportRef.current
    if (!element || !ready) return
    let currentView = view
    const wheel = (event: WheelEvent): void => {
      if (!event.deltaY) return
      event.preventDefault()
      currentView = zoomImage(
        currentView,
        currentView.scale * (event.deltaY < 0 ? IMAGE_ZOOM_FACTOR : 1 / IMAGE_ZOOM_FACTOR)
      )
      onViewChange(currentView)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [ready, view, onViewChange])

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col" data-testid="image-viewer">
      <div
        className="flex shrink-0 flex-wrap items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-line-2)] bg-[var(--vds-bg-gray-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[var(--vds-text-7)] [font-variant-numeric:tabular-nums]"
        role="toolbar"
        aria-label={imageText('image.toolbar')}
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label={imageText('image.zoomOut')}
          disabled={!ready || view.scale <= IMAGE_MIN_SCALE}
          onClick={() => saveView(zoomImage(view, view.scale / IMAGE_ZOOM_FACTOR))}
        >
          −
        </Button>
        <output data-testid="image-zoom" aria-label={imageText('image.zoom')}>
          {Math.round(view.scale * IMAGE_PERCENT)}%
        </output>
        <Button
          variant="ghost"
          size="sm"
          aria-label={imageText('image.zoomIn')}
          disabled={!ready || view.scale >= IMAGE_MAX_SCALE}
          onClick={() => saveView(zoomImage(view, view.scale * IMAGE_ZOOM_FACTOR))}
        >
          +
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!ready}
          aria-pressed={view.mode === 'fit'}
          onClick={() => saveView(fitImage(natural, viewport))}
        >
          {imageText('image.fit')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!ready}
          onClick={() => saveView({ mode: 'manual', scale: 1, x: 0, y: 0 })}
        >
          {imageText('image.actual')}
        </Button>
        {ready && (
          <span data-testid="image-dimensions">
            {natural.width} × {natural.height}
          </span>
        )}
        <span>{imageText('image.readonly')}</span>
      </div>
      <div
        ref={viewportRef}
        className="relative flex min-h-0 min-w-0 flex-1 cursor-grab items-center justify-center overflow-hidden bg-[var(--vds-fill-3)] [touch-action:none] [user-select:none] data-[dragging=true]:cursor-grabbing [&>img]:pointer-events-none [&>img]:absolute [&>img]:left-1/2 [&>img]:top-1/2 [&>img]:max-h-none [&>img]:max-w-none [&>img]:[transform-origin:center]"
        data-testid="image-viewport"
        data-scale={view.scale}
        data-pan-x={view.x}
        data-pan-y={view.y}
        data-mode={view.mode}
        data-dragging={dragging}
        onDoubleClick={() => {
          if (ready) saveView(toggleImageZoom(view, fitImage(natural, viewport)))
        }}
        onPointerDown={(event) => {
          if (!ready || event.button !== PRIMARY_POINTER_BUTTON || drag.current) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start?.pointerId === event.pointerId)
            saveView(panImage(start.view, event.clientX - start.x, event.clientY - start.y))
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          drag.current = null
          setDragging(false)
        }}
      >
        {url && !failed && (
          <img
            key={url}
            src={url}
            alt={title || imageText('viewer.image')}
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
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          />
        )}
        {failed || sourceFailed ? (
          <span role="alert">{imageText('image.error')}</span>
        ) : (
          !ready && <Spinner aria-label={imageText('image.loading')} />
        )}
      </div>
    </div>
  )
}
