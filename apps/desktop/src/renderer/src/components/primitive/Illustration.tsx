import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageOff } from 'lucide-react'
import { Button, Spinner } from '../ui'
import { ImagePreview } from './Gallery'
import { OFFICE_IMAGE_MEDIA_TYPE } from '../../../../images'

export function Illustration({
  source,
  url,
  alt,
  action,
  loadRemoteImage,
}: {
  source: string
  url?: string
  alt?: string
  action?: ReactNode
  loadRemoteImage?: (url: string) => Promise<Uint8Array>
}): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [failed, setFailed] = useState(false)
  const [resource, setResource] = useState(url)
  const [remote, setRemote] = useState<{ source: string; url?: string; failed?: boolean }>({
    source,
  })
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!loadRemoteImage) return
    let active = true
    let objectUrl: string | undefined
    setRemote({ source })
    setFailed(false)
    setOpen(false)
    void loadRemoteImage(source)
      .then((bytes) => {
        if (!active) return
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: OFFICE_IMAGE_MEDIA_TYPE })
        )
        setRemote({ source, url: objectUrl })
      })
      .catch(() => {
        if (active) setRemote({ source, failed: true })
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source, loadRemoteImage, attempt])
  if (resource !== url) {
    setResource(url)
    setFailed(false)
  }
  let name = source.split(/[?#]/, 1)[0].split('/').at(-1) || alt || t('markdown.image')
  try {
    name = decodeURIComponent(name)
  } catch {
    name = alt || name
  }
  const remoteUrl = loadRemoteImage && remote.source === source ? remote.url : undefined
  const displayUrl = url || remoteUrl
  if (loadRemoteImage && !remoteUrl && !remote.failed)
    return <Spinner aria-label={t('imagePreview.loading')} />
  if (displayUrl && !failed)
    return (
      <span className="block max-w-full">
        {remoteUrl ? (
          <>
            <Button
              unstyled
              aria-label={t('markdown.previewImage', { name: alt || name })}
              className="block max-w-full cursor-zoom-in"
              onClick={() => setOpen(true)}
            >
              <img
                src={remoteUrl}
                alt={alt || name}
                onError={() => setFailed(true)}
                className="max-w-full"
              />
            </Button>
            <ImagePreview
              images={[{ id: source, name: alt || name, src: remoteUrl }]}
              open={open}
              index={0}
              onOpenChange={setOpen}
              onIndexChange={() => undefined}
              onImageError={() => setFailed(true)}
            />
          </>
        ) : (
          <img
            crossOrigin="anonymous"
            src={displayUrl}
            alt={alt || name}
            onError={() => setFailed(true)}
            className="max-w-full"
          />
        )}
        {action}
      </span>
    )
  return (
    <span
      data-testid="answer-image-fallback"
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-6)] border border-dashed border-[var(--vds-border-default)] p-[var(--vds-space-4)] text-[var(--vds-text-tertiary)]"
    >
      <ImageOff aria-hidden="true" size="1em" className="shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        <span className="block">
          {t(url || loadRemoteImage ? 'markdown.imageFailed' : 'markdown.imageBlocked')}
        </span>
        <span className="block text-[length:var(--vds-font-body-lv3)]">{name}</span>
      </span>
      {action}
      {loadRemoteImage && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFailed(false)
            setAttempt((previous) => previous + 1)
          }}
        >
          {t('retry')}
        </Button>
      )}
    </span>
  )
}
