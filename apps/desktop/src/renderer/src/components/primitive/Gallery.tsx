import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Copy, X } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogPortal,
  DialogTitle,
  IconButton,
  ScrollArea,
  Spinner,
} from '../ui'
import {
  fitImage,
  panImage,
  zoomImage,
  IMAGE_DOUBLE_ZOOM_FACTOR,
  IMAGE_PERCENT,
  IMAGE_POINTER_BUTTON,
  IMAGE_ZOOM_FACTOR,
  type ImageViewState,
} from './geometry'

export interface ImagePreviewItem {
  id: string
  name: string
  src?: string
  error?: boolean
}

export interface ImagePreviewProps {
  images: readonly ImagePreviewItem[]
  open: boolean
  index: number
  onOpenChange: (open: boolean) => void
  onIndexChange: (index: number) => void
  onCopy?: (image: HTMLImageElement, index: number) => void
  copying?: boolean
  actions?: React.ReactNode
  errorActions?: React.ReactNode
  onImageError?: (index: number) => void
  testId?: string
}

const CONTROL_CLASS =
  '!size-[var(--vds-image-preview-control-size)] !min-h-0 !min-w-0 !rounded-none !border-0 ![background:var(--vds-image-preview-control-fill)] !p-0 !text-[var(--vds-static-white)] hover:![background:var(--vds-image-preview-control-hover-fill)] focus-visible:!ring-[var(--vds-static-white)]'
const NAVIGATION_CLASS = `${CONTROL_CLASS} !size-[var(--vds-image-preview-navigation-size)] absolute top-1/2 -translate-y-1/2`

export function ImagePreview({
  images,
  open,
  index,
  onOpenChange,
  onIndexChange,
  onCopy,
  copying = false,
  actions,
  errorActions,
  onImageError,
  testId = 'image-preview',
}: ImagePreviewProps): React.JSX.Element | null {
  const { t } = useTranslation('ui')
  const selected = Math.max(0, Math.min(index, images.length - 1))
  const current = images[selected]
  const stage = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const drag = useRef<{ pointer: number; x: number; y: number; view: ImageViewState } | null>(null)
  const [view, setView] = useState<ImageViewState>({ mode: 'fit', scale: 1, x: 0, y: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [decodeFailed, setDecodeFailed] = useState(false)
  const failed = Boolean(current?.error || decodeFailed)
  const ready = size.width > 0 && size.height > 0 && !failed
  const actual = view.mode === 'fit' ? fitImage(size, viewport) : view

  useEffect(() => {
    setView({ mode: 'fit', scale: 1, x: 0, y: 0 })
    setSize({ width: 0, height: 0 })
    setDecodeFailed(false)
    drag.current = null
    const element = stage.current
    if (!element || !open) return
    const measure = (): void =>
      setViewport({ width: element.clientWidth, height: element.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [open, selected, current?.id, current?.src])

  useEffect(() => {
    const element = stage.current
    if (!element || !open) return
    const wheel = (event: WheelEvent): void => {
      if (!ready) return
      event.preventDefault()
      setView((previous) => {
        const next = previous.mode === 'fit' ? fitImage(size, viewport) : previous
        return zoomImage(
          next,
          next.scale * (event.deltaY < 0 ? IMAGE_ZOOM_FACTOR : 1 / IMAGE_ZOOM_FACTOR)
        )
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [open, selected, ready, size.width, size.height, viewport.width, viewport.height])

  if (!current) return null
  const fail = (): void => {
    setDecodeFailed(true)
    onImageError?.(selected)
  }
  const finishDrag = (event: React.PointerEvent<HTMLImageElement>): void => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogContent
          hideCloseButton
          aria-label={current.name}
          data-testid={testId}
          overlayClassName="no-drag !z-[var(--vds-z-overlay)] !bg-[var(--vds-image-preview-mask)] backdrop-blur-[var(--vds-image-preview-blur)]"
          className="no-drag !z-[var(--vds-z-modal)] !h-full !max-h-none !w-full !max-w-none !gap-0 !rounded-none !border-0 !bg-transparent !p-0 !text-[var(--vds-static-white)] !shadow-none"
          onClick={(event) => {
            if (event.target === event.currentTarget) onOpenChange(false)
          }}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return
            if (event.key === 'ArrowLeft' && selected > 0) {
              event.preventDefault()
              onIndexChange(selected - 1)
            }
            if (event.key === 'ArrowRight' && selected < images.length - 1) {
              event.preventDefault()
              onIndexChange(selected + 1)
            }
          }}
        >
          <DialogTitle className="absolute left-[var(--vds-image-preview-padding)] top-[var(--vds-image-preview-padding)] !m-0 max-w-[calc(100%-var(--vds-image-preview-toolbar-width))] truncate !text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-lh-body-lv1)] !text-[var(--vds-static-white)]">
            {current.name}
          </DialogTitle>
          <div
            className="absolute right-[var(--vds-image-preview-padding)] top-[var(--vds-space-3)] flex items-center gap-[var(--vds-space-2)] [&_button]:!size-[var(--vds-image-preview-control-size)] [&_button]:!min-h-0 [&_button]:!min-w-0 [&_button]:!rounded-none [&_button]:!border-0 [&_button]:![background:var(--vds-image-preview-control-fill)] [&_button]:!p-0 [&_button]:!text-[var(--vds-static-white)] [&_button:hover]:![background:var(--vds-image-preview-control-hover-fill)]"
            role="toolbar"
            aria-label={t('imagePreview.toolbar')}
          >
            {onCopy && (
              <IconButton
                className={CONTROL_CLASS}
                label={t('imagePreview.copy')}
                icon={<Copy />}
                disabled={!ready || copying}
                onClick={() => {
                  if (picture.current) onCopy(picture.current, selected)
                }}
              />
            )}
            {actions}
            <IconButton
              className={CONTROL_CLASS}
              label={t('imagePreview.close')}
              icon={<X />}
              onClick={() => onOpenChange(false)}
            />
          </div>
          <div
            ref={stage}
            className="absolute inset-x-[var(--vds-image-preview-stage-inset)] bottom-[var(--vds-image-preview-stage-bottom)] top-[var(--vds-image-preview-stage-top)] flex touch-none items-center justify-center overflow-hidden"
            data-testid="image-preview-stage"
            data-scale={actual.scale}
            data-pan-x={actual.x}
            data-pan-y={actual.y}
            onClick={(event) => {
              if (event.target === event.currentTarget) onOpenChange(false)
            }}
          >
            {current.src && !failed ? (
              <img
                key={`${current.id}:${current.src}`}
                ref={picture}
                src={current.src}
                alt={current.name}
                draggable={false}
                className="absolute left-1/2 top-1/2 max-h-none max-w-none cursor-grab select-none rounded-[var(--vds-radius-3)] shadow-[var(--vds-shadow-2-center)]"
                style={{
                  width: size.width || undefined,
                  height: size.height || undefined,
                  visibility: ready ? 'visible' : 'hidden',
                  transform: `translate(-50%, -50%) translate(${actual.x}px, ${actual.y}px) scale(${actual.scale})`,
                }}
                onLoad={(event) => {
                  const { naturalWidth: width, naturalHeight: height } = event.currentTarget
                  if (width && height) setSize({ width, height })
                  else fail()
                }}
                onError={fail}
                onDoubleClick={() =>
                  setView(
                    view.mode === 'fit'
                      ? {
                          mode: 'manual',
                          scale: Math.max(1, actual.scale * IMAGE_DOUBLE_ZOOM_FACTOR),
                          x: 0,
                          y: 0,
                        }
                      : { mode: 'fit', scale: 1, x: 0, y: 0 }
                  )
                }
                onPointerDown={(event) => {
                  if (!ready || event.button !== IMAGE_POINTER_BUTTON || view.mode === 'fit') return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  drag.current = {
                    pointer: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    view: actual,
                  }
                }}
                onPointerMove={(event) => {
                  const start = drag.current
                  if (start?.pointer === event.pointerId)
                    setView(panImage(start.view, event.clientX - start.x, event.clientY - start.y))
                }}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
                onLostPointerCapture={() => {
                  drag.current = null
                }}
              />
            ) : failed ? (
              <div role="alert" className="max-w-full text-center text-[var(--vds-static-white)]">
                <p>
                  {decodeFailed ? t('imagePreview.decodeFailed') : t('imagePreview.loadFailed')}
                </p>
                <p className="break-all">{current.name}</p>
                {errorActions}
              </div>
            ) : (
              <Spinner aria-label={t('imagePreview.loading')} />
            )}
          </div>
          <IconButton
            className={`${NAVIGATION_CLASS} left-[var(--vds-image-preview-padding)]`}
            label={t('imagePreview.previous')}
            icon={<ChevronLeft />}
            disabled={selected === 0}
            onClick={() => onIndexChange(selected - 1)}
          />
          <IconButton
            className={`${NAVIGATION_CLASS} right-[var(--vds-image-preview-padding)]`}
            label={t('imagePreview.next')}
            icon={<ChevronRight />}
            disabled={selected === images.length - 1}
            onClick={() => onIndexChange(selected + 1)}
          />
          <div className="absolute bottom-[var(--vds-space-3)] left-1/2 flex max-w-[calc(100%-var(--vds-image-preview-stage-inset)*2)] -translate-x-1/2 flex-col items-center gap-[var(--vds-space-half)]">
            <ScrollArea orientation="horizontal" className="max-w-full">
              <div className="flex w-max items-center">
                {images.map((item, itemIndex) => (
                  <Button
                    unstyled
                    className="grid h-[var(--vds-space-5)] w-[calc(var(--vds-image-preview-dot-size)+var(--vds-space-2))] shrink-0 place-items-center rounded-[var(--vds-radius-circle)]"
                    key={item.id}
                    aria-label={t('imagePreview.goto', { index: itemIndex + 1 })}
                    aria-pressed={selected === itemIndex}
                    onClick={() => onIndexChange(itemIndex)}
                  >
                    <span
                      className={
                        selected === itemIndex
                          ? 'size-[var(--vds-image-preview-dot-size)] rounded-[var(--vds-radius-circle)] bg-[var(--vds-static-white)]'
                          : 'size-[var(--vds-image-preview-dot-size)] rounded-[var(--vds-radius-circle)] bg-[var(--vds-other-white-overlay-1)]'
                      }
                    />
                  </Button>
                ))}
              </div>
            </ScrollArea>
            <output className="whitespace-nowrap rounded-[var(--vds-radius-pill)] bg-[var(--vds-image-preview-control-bg)] px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]">
              {t('imagePreview.position', {
                index: selected + 1,
                count: images.length,
                zoom: Math.round(actual.scale * IMAGE_PERCENT),
              })}
            </output>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
