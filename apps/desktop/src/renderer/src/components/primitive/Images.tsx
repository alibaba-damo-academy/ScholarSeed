import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, ScrollArea, Spinner, Tooltip, cx } from '../ui'
import { ImagePreview, type ImagePreviewItem } from './Gallery'
import { copyImageElement } from './clipboard'
import { AttachmentContainer } from './Attachment'

export interface ConversationImage {
  id: string
  title: string
  url?: string
  failed?: boolean
  fit?: 'contain' | 'cover'
  preview?: React.ReactNode
  onOpen?: () => void
  onReload?: () => void
}

export const VISIBLE_IMAGES = 3

export function ImageThumbnail({
  item,
  onOpen,
  large = false,
}: {
  item: ConversationImage
  onOpen: () => void
  large?: boolean
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation('workbench')
  return (
    <Button
      unstyled
      aria-label={item.title}
      onClick={onOpen}
      className={cx(
        'flex w-full items-center justify-center overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-line-2)] bg-[var(--vds-surface-muted)]',
        large ? 'min-h-[var(--vds-space-8)]' : 'aspect-square'
      )}
    >
      {failed || item.failed ? (
        <span role="alert">{t('image.error')}</span>
      ) : item.url ? (
        <img
          src={item.url}
          alt={item.title}
          onError={() => setFailed(true)}
          className={
            large
              ? 'max-h-[var(--vds-preview-content-max-height)] w-full object-contain'
              : item.fit === 'contain'
                ? 'h-full w-full object-contain'
                : 'h-full w-full object-cover'
          }
        />
      ) : (
        <Spinner aria-label={t('image.loading')} />
      )}
    </Button>
  )
}

export function Images({
  items,
  renderActions,
  renderPreviewActions,
  selection,
  thumbnails = true,
  captions = true,
  hoverActions = false,
}: {
  items: readonly ConversationImage[]
  renderActions?: (item: ConversationImage) => React.ReactNode
  renderPreviewActions?: (item: ConversationImage, onClose: () => void) => React.ReactNode
  selection?: { id: string | null; onChange: (id: string | null) => void }
  thumbnails?: boolean
  captions?: boolean
  hoverActions?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('ui')
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [copyMessage, setCopyMessage] = useState('')
  const selectedId = selection ? selection.id : localSelectedId
  const setSelectedId = selection ? selection.onChange : setLocalSelectedId
  const viewerItems = items.filter((item) => !item.onOpen)
  const selectedIndex = viewerItems.findIndex((item) => item.id === selectedId)
  const selected = viewerItems[selectedIndex]
  if (!items.length) return null
  const compact = items.length > VISIBLE_IMAGES
  return (
    <>
      {thumbnails && (
        <ScrollArea
          orientation="horizontal"
          className="w-full max-w-[var(--vds-preview-width)]"
          viewportClassName="![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden"
          viewportProps={{ 'data-slot': 'conversation-images-viewport' }}
          horizontalControls={
            compact
              ? {
                  previous: t('imageAttachments.scrollPrevious'),
                  next: t('imageAttachments.scrollNext'),
                  hoverOnly: true,
                  variant: 'image',
                  scrollBy: 'items',
                }
              : undefined
          }
        >
          <div className="flex w-full gap-[var(--vds-space-4)]">
            {items.map((item) => (
              <div
                key={item.id}
                className="group/image relative min-w-0 shrink-0"
                style={{
                  width: `calc((100% - ${Math.min(VISIBLE_IMAGES, items.length) - 1} * var(--vds-space-4)) / ${Math.min(VISIBLE_IMAGES, items.length)})`,
                }}
              >
                <div className={hoverActions ? 'relative' : 'contents'}>
                  {item.preview ?? (
                    <ImageThumbnail
                      key={item.url}
                      item={item}
                      large={items.length === 1}
                      onOpen={item.onOpen ?? (() => setSelectedId(item.id))}
                    />
                  )}
                  {renderActions && (
                    <div
                      className={
                        hoverActions
                          ? 'pointer-events-none absolute bottom-[var(--vds-space-2)] right-[var(--vds-space-2)] z-[var(--vds-z-local-control)] opacity-0 group-hover/image:pointer-events-auto group-hover/image:opacity-[var(--vds-opacity-full)] group-focus-within/image:pointer-events-auto group-focus-within/image:opacity-[var(--vds-opacity-full)] has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-[var(--vds-opacity-full)]'
                          : compact
                            ? 'absolute right-[var(--vds-space-1)] top-[var(--vds-space-1)] opacity-0 group-hover/image:opacity-[var(--vds-opacity-full)] group-focus-within/image:opacity-[var(--vds-opacity-full)]'
                            : 'absolute right-[var(--vds-space-1)] top-[var(--vds-space-1)]'
                      }
                    >
                      {renderActions(item)}
                    </div>
                  )}
                </div>
                {captions && !compact && (
                  <div className="truncate text-[var(--vds-text-secondary)]" title={item.title}>
                    {item.title}
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
      <ImagePreview
        images={viewerItems.map((item) => ({
          id: item.id,
          name: item.title,
          src: item.url,
          error: item.failed,
        }))}
        open={Boolean(selected)}
        index={Math.max(0, selectedIndex)}
        onIndexChange={(index) => {
          setCopyMessage('')
          setSelectedId(viewerItems[index].id)
        }}
        onOpenChange={(open) => {
          setCopyMessage('')
          if (!open) setSelectedId(null)
        }}
        copying={copying}
        errorActions={
          selected?.onReload && (
            <Button variant="secondary" onClick={selected.onReload}>
              {t('imagePreview.reload')}
            </Button>
          )
        }
        onCopy={(image) => {
          setCopying(true)
          setCopyMessage('')
          void copyImageElement(image)
            .then(
              () => setCopyMessage(t('copy.success')),
              () => setCopyMessage(t('copy.error'))
            )
            .finally(() => setCopying(false))
        }}
        actions={
          selected && (
            <>
              {copyMessage && <span role="status">{copyMessage}</span>}
              {renderPreviewActions
                ? renderPreviewActions(selected, () => setSelectedId(null))
                : renderActions?.(selected)}
            </>
          )
        }
      />
    </>
  )
}

export interface ImageAttachmentsProps {
  images: readonly ImagePreviewItem[]
  onOpen: (index: number) => void
  onRemove?: (index: number) => void
  onImageError?: (index: number) => void
}

export function ImageAttachments({
  images,
  onOpen,
  onRemove,
  onImageError,
}: ImageAttachmentsProps): React.JSX.Element | null {
  const { t } = useTranslation('ui')
  if (!images.length) return null
  return (
    <div
      className="group/images relative flex w-max shrink-0 gap-[var(--vds-composer-attachment-gap)] py-[var(--vds-space-1)]"
      data-testid="attachment-images"
    >
      {images.map((item, imageIndex) => (
        <AttachmentContainer
          key={item.id}
          className="shrink-0"
          onRemove={onRemove ? () => onRemove(imageIndex) : undefined}
          removeLabel={t('imageAttachments.remove', { name: item.name })}
        >
          <Tooltip content={item.name} disabled={!item.error} portalled>
            <Button
              unstyled
              className={cx(
                'relative block overflow-hidden rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)]',
                item.error
                  ? 'h-[var(--vds-attachment-thumbnail-size)] w-[var(--vds-attachment-card-width)] text-left'
                  : 'size-[var(--vds-attachment-thumbnail-size)]'
              )}
              aria-description={item.error ? t('imagePreview.loadFailed') : undefined}
              aria-label={t('imageAttachments.open', {
                name: item.name,
                index: imageIndex + 1,
                count: images.length,
              })}
              onClick={() => onOpen(imageIndex)}
            >
              {item.src && !item.error ? (
                <img
                  className="size-full object-cover"
                  src={item.src}
                  alt={item.name}
                  onError={() => onImageError?.(imageIndex)}
                />
              ) : item.error ? (
                <span className="block min-w-0 p-[var(--vds-space-1)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]">
                  <span className="block">{t('imagePreview.loadFailed')}</span>
                  <span className="block truncate">{item.name}</span>
                </span>
              ) : (
                <Spinner />
              )}
            </Button>
          </Tooltip>
        </AttachmentContainer>
      ))}
    </div>
  )
}
