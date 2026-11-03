import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  Dialog,
  DialogContent,
  DialogPortal,
  DialogTitle,
  Spinner,
} from '../ui'
import { ImageView } from './Image'

export interface ConversationImage {
  id: string
  title: string
  url?: string
  failed?: boolean
}

const VISIBLE_IMAGES = 3

export function ImageThumbnail({
  item,
  onOpen,
}: {
  item: ConversationImage
  onOpen: () => void
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation('workbench')
  return (
    <Button
      unstyled
      aria-label={item.title}
      onClick={onOpen}
      className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-line-2)] bg-[var(--vds-surface-muted)]"
    >
      {failed || item.failed ? (
        <span role="alert">{t('image.error')}</span>
      ) : item.url ? (
        <img
          src={item.url}
          alt={item.title}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Spinner aria-label={t('image.loading')} />
      )}
    </Button>
  )
}

function Viewer({ item }: { item: ConversationImage }): React.JSX.Element {
  const [viewState, setViewState] = useState<Record<string, unknown>>({})
  return (
    <ImageView
      url={item.url ?? ''}
      title={item.title}
      failed={item.failed}
      viewState={viewState}
      onViewChange={(next) => setViewState({ ...next })}
    />
  )
}

export function Images({
  items,
  renderActions,
  selection,
  thumbnails = true,
}: {
  items: readonly ConversationImage[]
  renderActions?: (item: ConversationImage) => React.ReactNode
  selection?: { id: string | null; onChange: (id: string | null) => void }
  thumbnails?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('ui')
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null)
  const selectedId = selection ? selection.id : localSelectedId
  const setSelectedId = selection ? selection.onChange : setLocalSelectedId
  const selectedIndex = items.findIndex((item) => item.id === selectedId)
  const selected = items[selectedIndex]
  if (!items.length) return null
  return (
    <>
      {thumbnails && (
        <Carousel
          visibleItems={Math.min(VISIBLE_IMAGES, items.length)}
          className="w-full max-w-[var(--vds-preview-width)]"
        >
          <CarouselContent>
            {items.map((item) => (
              <CarouselItem key={item.id} className="!min-h-0 !border-0 !bg-transparent">
                <div className="w-full min-w-0">
                  <ImageThumbnail
                    key={item.url}
                    item={item}
                    onOpen={() => setSelectedId(item.id)}
                  />
                  <div className="truncate text-[var(--vds-text-secondary)]" title={item.title}>
                    {item.title}
                  </div>
                  {renderActions?.(item)}
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          {items.length > VISIBLE_IMAGES && (
            <>
              <CarouselPrevious />
              <CarouselNext />
            </>
          )}
        </Carousel>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <DialogPortal>
          <DialogContent
            className="!w-[var(--vds-preview-width)]"
            overlayProps={{ onClick: () => setSelectedId(null) }}
          >
            {selected && (
              <>
                <DialogTitle>{selected.title}</DialogTitle>
                <div className="h-[var(--vds-preview-content-max-height)] min-h-0">
                  <Viewer key={selected.id} item={selected} />
                </div>
                <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
                  <Button
                    disabled={selectedIndex === 0}
                    onClick={() => setSelectedId(items[selectedIndex - 1].id)}
                  >
                    {t('pagination.previous')}
                  </Button>
                  <output>
                    {selectedIndex + 1} / {items.length}
                  </output>
                  <Button
                    disabled={selectedIndex === items.length - 1}
                    onClick={() => setSelectedId(items[selectedIndex + 1].id)}
                  >
                    {t('pagination.next')}
                  </Button>
                </div>
                {renderActions?.(selected)}
              </>
            )}
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  )
}
