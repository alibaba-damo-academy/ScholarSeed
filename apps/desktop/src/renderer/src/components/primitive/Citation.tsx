import { forwardRef, type ReactNode } from 'react'
import { Button, type ButtonProps } from '../ui'

export const CITATION_MARKER_CLASS =
  'inline-flex h-[var(--vds-assistant-web-citation-height)] max-w-[min(100%,var(--vds-assistant-citation-marker-max-width))] cursor-pointer items-center rounded-[var(--vds-radius-4)] border-0 bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-2)] align-baseline text-left text-[length:var(--vds-font-body-lv1)] [font-weight:var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]! hover:bg-[var(--vds-other-overlay-2)] focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)] [&_[data-citation-icon]]:!size-[var(--vds-icon-6)] [&_[data-citation-icon]>*]:!size-[var(--vds-icon-6)]'

export const CITATION_PREVIEW_SURFACE_CLASS =
  'max-h-[var(--vds-assistant-citation-panel-height)] overflow-y-auto border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-3)] !shadow-[var(--vds-shadow-2-center)] [font-weight:var(--vds-fw-regular)]'

export const CITATION_PREVIEW_CLASS = `${CITATION_PREVIEW_SURFACE_CLASS} !w-[var(--vds-assistant-citation-panel-width)] !max-w-[var(--vds-assistant-floating-panel-width)] rounded-[var(--vds-radius-4)]`

export const CITATION_PREVIEW_TITLE_CLASS =
  'min-w-0 text-left text-[length:var(--vds-font-body-lv2)] ![font-weight:var(--vds-fw-medium)] text-[var(--vds-text-primary)]'

export function CitationMarkerTitle({ title, file = false }: { title: ReactNode; file?: boolean }) {
  const filename = file && typeof title === 'string' ? /^(.+)(\.[a-z\d]+)$/i.exec(title) : null
  return filename ? (
    <span className="inline-flex min-w-0">
      <span className="min-w-0 truncate">{filename[1]}</span>
      <span className="shrink-0">{filename[2]}</span>
    </span>
  ) : (
    <span className="min-w-0 truncate">{title}</span>
  )
}

/** Presentation only: each caller retains its evidence resolution and navigation. */
export const CitationMarker = forwardRef<
  HTMLButtonElement,
  ButtonProps & {
    label: string
  }
>(({ label, children, className = CITATION_MARKER_CLASS, ...props }, ref) => (
  <Button {...props} ref={ref} unstyled className={className}>
    <span data-citation-label className="inline-flex min-w-0 items-center gap-[var(--vds-space-1)]">
      {children ?? label}
    </span>
  </Button>
))

CitationMarker.displayName = 'CitationMarker'
