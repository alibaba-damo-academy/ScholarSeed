import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { CitationResolution } from '../../contracts/citations'
import { Button, Popover, PopoverContent, Spinner } from '../../components/ui'
import {
  CITATION_PREVIEW_CLASS,
  CITATION_PREVIEW_TITLE_CLASS,
} from '../../components/primitive/Citation'
import { bibliographyUrl, parseBibliography, type BibliographyPreview } from './bibliography'

export interface BibliographyCardProps {
  anchorRef: RefObject<HTMLElement | null>
  preview: BibliographyPreview | null
  handle?: string
  referenceHref?: string
  resolveReference?: (href: string) => Promise<BibliographyPreview>
  resolve: (handle: string) => Promise<CitationResolution>
  onClose: () => void
  onEnter: () => void
  onLeave: () => void
  onOpen: (url: string) => void
}

export function BibliographyCard({
  anchorRef,
  preview,
  handle,
  referenceHref,
  resolveReference,
  resolve,
  onClose,
  onEnter,
  onLeave,
  onOpen,
}: BibliographyCardProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const [resolved, setResolved] = useState<BibliographyPreview | null>(null)
  const [loading, setLoading] = useState(Boolean(handle || referenceHref))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const closeAfterSourceScroll = (event: Event): void => {
      const target = event.target
      if (target === window || (target instanceof Node && target.contains(anchorRef.current)))
        onClose()
    }
    window.addEventListener('scroll', closeAfterSourceScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('scroll', closeAfterSourceScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchorRef, onClose])
  useEffect(() => {
    let active = true
    setResolved(null)
    setFailed(false)
    setLoading(Boolean(handle || referenceHref))
    const pending = handle
      ? resolve(handle).then((source) => ({
          metadata: parseBibliography(source.bibliography),
          reference: source.title,
        }))
      : referenceHref && resolveReference
        ? resolveReference(referenceHref)
        : null
    if (pending)
      void pending
        .then((source) => {
          if (active) setResolved(source)
        })
        .catch(() => {
          if (active) setFailed(true)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    return () => {
      active = false
    }
  }, [handle, referenceHref, resolve, resolveReference])
  const bounds = anchorRef.current?.getBoundingClientRect()
  if (!bounds) return null
  const content = handle || referenceHref ? resolved : preview
  const metadata = content?.metadata
  const url = metadata ? bibliographyUrl(metadata) : ''
  const title = metadata?.title || content?.reference || t('bibliography.unavailable')
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <PopoverContent
        autoFocus={false}
        position={{
          kind: 'anchor',
          top: bounds.top,
          left: bounds.left,
          bottom: bounds.bottom,
          width: bounds.width,
        }}
        className={CITATION_PREVIEW_CLASS}
        data-testid="bibliography-preview"
        aria-label={t('bibliography.preview')}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave()
        }}
      >
        {loading ? (
          <Spinner aria-label={t('bibliography.loading')} />
        ) : failed ? (
          <p role="status">{t('bibliography.failed')}</p>
        ) : (
          <div className="grid min-w-0 gap-[var(--vds-space-2)] [overflow-wrap:anywhere]">
            {url ? (
              <Button
                unstyled
                className={`${CITATION_PREVIEW_TITLE_CLASS} w-full whitespace-normal leading-[var(--vds-lh-body-lv2)] hover:text-[var(--vds-brand-text-primary)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)]`}
                onClick={() => onOpen(url)}
              >
                {title}
              </Button>
            ) : (
              <p className={`${CITATION_PREVIEW_TITLE_CLASS} m-0 leading-[var(--vds-lh-body-lv2)]`}>
                {title}
              </p>
            )}
            {metadata ? (
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[var(--vds-space-3)] gap-y-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)]">
                <dt className="text-[var(--vds-text-secondary)]">{t('bibliography.authors')}</dt>
                <dd className="m-0">{metadata.authors || t('bibliography.missing')}</dd>
                <dt className="text-[var(--vds-text-secondary)]">{t('bibliography.year')}</dt>
                <dd className="m-0">{metadata.year || t('bibliography.missing')}</dd>
                <dt className="text-[var(--vds-text-secondary)]">
                  {t('bibliography.publication')}
                </dt>
                <dd className="m-0">{metadata.publication || t('bibliography.missing')}</dd>
              </dl>
            ) : (
              <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                {t('bibliography.unstructured')}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
