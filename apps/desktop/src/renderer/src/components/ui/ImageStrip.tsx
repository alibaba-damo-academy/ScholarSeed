import type { JSX, ReactNode } from 'react'
import type { HTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from './Button'
import { Badge } from './Badge'
import { ScrollArea } from './ScrollArea'
import { Spinner } from './Spinner'
import { Tooltip } from './Tooltip'
import { cx } from './utils'

export interface ImageStripItem {
  id: string
  name: string
  src?: string
  error?: boolean
  sourceLabel?: string
}

export interface ImageStripProps extends HTMLAttributes<HTMLDivElement> {
  images: readonly ImageStripItem[]
  onOpen: (index: number) => void
  onImageError?: (index: number) => void
  showNames?: boolean
  renderActions?: (index: number) => ReactNode
}

export function ImageStrip({
  images,
  onOpen,
  onImageError,
  showNames = false,
  renderActions,
  className,
  ...props
}: ImageStripProps): JSX.Element | null {
  const { t } = useTranslation('ui')
  if (!images.length) return null

  return (
    <div
      data-slot="image-strip"
      className={cx('group/image-strip relative min-w-0 max-w-full', className)}
      {...props}
    >
      <ScrollArea
        orientation="horizontal"
        className="max-w-full"
        viewportClassName="![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden"
        viewportProps={{ 'data-slot': 'image-strip-viewport' }}
        horizontalControls={{
          previous: t('imageAttachments.scrollPrevious'),
          next: t('imageAttachments.scrollNext'),
          hoverOnly: true,
          variant: 'image',
          scrollBy: 'items',
        }}
      >
        <div className="ml-auto flex w-max gap-[var(--vds-image-strip-gap)]">
          {images.map((image, index) => (
            <div
              key={image.id}
              className="group/image relative w-[var(--vds-image-strip-size)] shrink-0"
            >
              <Tooltip content={image.name} disabled={!image.error} portalled>
                <Button
                  unstyled
                  data-slot="image-strip-item"
                  className="relative grid size-[var(--vds-image-strip-size)] shrink-0 place-items-center overflow-hidden rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)]"
                  aria-label={t('imageAttachments.open', {
                    name: image.name,
                    index: index + 1,
                    count: images.length,
                  })}
                  aria-description={image.error ? t('imagePreview.loadFailed') : undefined}
                  onClick={() => onOpen(index)}
                >
                  {image.src && !image.error ? (
                    <img
                      src={image.src}
                      alt={image.name}
                      className="block size-full object-cover"
                      onError={() => onImageError?.(index)}
                    />
                  ) : image.error ? (
                    <span className="block w-full min-w-0 p-[var(--vds-space-1)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]">
                      <span className="block">{t('imagePreview.loadFailed')}</span>
                      <span className="block truncate">{image.name}</span>
                    </span>
                  ) : (
                    <Spinner />
                  )}
                  {image.sourceLabel && (
                    <Badge
                      size="sm"
                      tone="neutral"
                      data-slot="image-source-label"
                      className="pointer-events-none absolute left-[var(--vds-space-2)] top-[var(--vds-space-2)] max-w-[calc(100%-var(--vds-space-4))] !h-auto !min-h-0 !rounded-[var(--vds-radius-2)] !border-0 ![background:var(--vds-other-white-overlay-1)] !px-[var(--vds-space-1)] !py-[var(--vds-border-width-1)] !text-[length:var(--vds-font-caption)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-lh-caption)] !text-[var(--vds-text-6)] !shadow-none"
                    >
                      <span className="truncate">{image.sourceLabel}</span>
                    </Badge>
                  )}
                </Button>
              </Tooltip>
              {showNames && (
                <div className="truncate text-[var(--vds-text-secondary)]" title={image.name}>
                  {image.name}
                </div>
              )}
              {renderActions && (
                <div
                  className={cx(
                    'absolute right-[var(--vds-space-1)] top-[var(--vds-space-1)]',
                    !showNames &&
                      'opacity-0 group-hover/image:opacity-[var(--vds-opacity-full)] group-focus-within/image:opacity-[var(--vds-opacity-full)]'
                  )}
                >
                  {renderActions(index)}
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
