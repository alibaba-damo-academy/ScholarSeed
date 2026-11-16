import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_LANGUAGE } from '../../../../localization/catalog'
import { createFormatters } from '../../../../localization/format'
import type { PreferenceLanguage } from '../../../../preferences'

import { ChevronDown, ChevronRight, ChevronUp, Globe } from 'lucide-react'
import { IconFont } from '../primitive/Iconfont'
import {
  FILE_FALLBACK_ICON_CLASS_NAME,
  FileFormatIcon,
  hasFileFormatAsset,
} from '../primitive/FileIcon'
import {
  CitationMarker,
  CitationMarkerTitle,
  CITATION_MARKER_CLASS,
  CITATION_PREVIEW_CLASS,
  CITATION_PREVIEW_SURFACE_CLASS,
  CITATION_PREVIEW_TITLE_CLASS,
} from '../primitive/Citation'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  IconButton,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from '../ui'
import type { CitationResolution } from '../../contracts/citations'
import type { AnswerCoverage, AnswerSource } from '../../model'
import { citationDisplay, citationOrigin } from '../../features/assistant/display'
import { createScrollbarVisibility } from './scroll'
import {
  citationSourceType,
  groupCitationSources,
  type CitationReference,
  type CitationTarget,
} from './grouping'

type CitationIdentity = Pick<CitationResolution, 'path' | 'title' | 'bibliography'> &
  Partial<Pick<CitationResolution, 'source_kind'>>

const COVERAGE_MESSAGE_KEYS = {
  pending: 'citations.coverage.pending',
  reviewing: 'citations.coverage.reviewing',
  reviewed: 'citations.coverage.reviewed',
  partial: 'citations.coverage.partial',
  unavailable: 'citations.coverage.unavailable',
  interrupted: 'citations.coverage.interrupted',
} as const

function useCitationText() {
  const { t: citationText, i18n } = useTranslation('assistant')
  const format = createFormatters((i18n.resolvedLanguage ?? DEFAULT_LANGUAGE) as PreferenceLanguage)
  const statuses = {
    exact: citationText('citations.status.exact'),
    source_only: citationText('citations.status.sourceOnly'),
    unavailable: citationText('citations.status.unavailable'),
    changed: citationText('citations.status.changed'),
  }
  const contentLabels: Record<string, string> = {
    selection: citationText('citations.content.selection'),
    fulltext: citationText('citations.content.fulltext'),
    source_excerpt: citationText('citations.content.sourceExcerpt'),
    abstract: citationText('citations.content.abstract'),
    papercard: citationText('citations.content.papercard'),
    structured_text: citationText('citations.content.structuredText'),
  }
  const pageLabel = (pages: CitationResolution['pages']): string | undefined =>
    pages.length
      ? citationText('citations.pages', {
          pages: pages
            .map(({ page }) => format.number(page))
            .join(citationText('citations.pageSeparator')),
        })
      : undefined
  const location = (source: CitationResolution): string =>
    citationText('citations.location', {
      pages:
        pageLabel(source.pages) ??
        (source.path.toLowerCase().endsWith('.pdf')
          ? citationText('citations.noPages')
          : source.path),
      content: contentLabels[source.content_level] ?? source.content_level,
    })
  const attribution = (bibliography: CitationResolution['bibliography']) => {
    const [firstAuthor, ...coauthors] =
      bibliography?.authors
        .split(', ')
        .map((name) => name.trim())
        .filter(Boolean) ?? []
    const author = coauthors.length
      ? citationText('citations.paperMultipleAuthors', { author: firstAuthor })
      : (firstAuthor ?? '')
    const year = bibliography?.year.trim() ?? ''
    return { author, year, byline: [author, year].filter(Boolean).join(' · ') }
  }
  return { citationText, statuses, location, pageLabel, format, attribution }
}
const COVERAGE_PROGRESS_STATUSES = new Set<AnswerCoverage['status']>(['pending', 'reviewing'])
const SOURCE_ICON_LIMIT = 5
const CITATION_NAVIGATION_CLASS =
  '!size-[var(--vds-icon-7)] !min-w-[var(--vds-icon-7)] !rounded-[var(--vds-radius-2)] !text-[var(--vds-icon-outline-default)] disabled:!text-[var(--vds-text-disabled)] [&_.vds-icon-button__content]:!size-[var(--vds-icon-7)] [&_.iconfont]:!text-[length:var(--vds-icon-7)]'
const CITATION_TYPE_CLASS =
  'shrink-0 !rounded-[var(--vds-radius-2)] !border-0 !bg-[var(--vds-assistant-source-tag-background)] !px-[calc(var(--vds-space-1)+var(--vds-space-half))] !text-[length:var(--vds-font-caption)] !leading-[var(--vds-lh-caption)] !shadow-[var(--vds-assistant-source-tag-stroke)]'
const SOURCE_DIRECTORY_CLASS =
  'flex w-full rounded-[var(--vds-radius-4)] p-[var(--vds-space-2)] text-left [font-weight:var(--vds-fw-regular)] hover:bg-[var(--vds-other-overlay-1)] focus-visible:bg-[var(--vds-other-overlay-1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vds-brand-text-primary)] [&>[data-citation-label]]:w-full'
const CITATION_ATTRIBUTION_CLASS =
  'min-w-0 truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]'

function SourceDirectoryContent({
  icon,
  origin,
  title,
  details,
  excerpt,
  attribution,
  typeLabel,
  status,
}: {
  icon?: React.ReactNode
  origin?: string
  title: React.ReactNode
  details?: string
  excerpt?: string
  attribution?: string
  typeLabel: string
  status?: string
}): React.JSX.Element {
  const heading = (
    <span
      data-citation-source-title
      className="line-clamp-2 min-w-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-assistant-source-title-line-height)] [font-weight:var(--vds-fw-medium)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]"
    >
      {title}
    </span>
  )
  return (
    <span className="grid min-w-0 w-full gap-[calc(var(--vds-space-3)/2)] [font-weight:var(--vds-fw-regular)]">
      <span className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)]">
        {origin ? (
          <span className="flex min-w-0 items-center gap-[calc(var(--vds-space-3)/2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
            {icon}
            <span data-citation-source-domain className="min-w-0 truncate">
              {origin}
            </span>
          </span>
        ) : (
          heading
        )}
        <Badge
          size="sm"
          tone="neutral"
          className={`![font-weight:var(--vds-fw-regular)] ${CITATION_TYPE_CLASS}`}
          title={details}
        >
          {typeLabel}
        </Badge>
      </span>
      {origin && heading}
      {attribution && <span className={CITATION_ATTRIBUTION_CLASS}>{attribution}</span>}
      {excerpt && (
        <span
          data-citation-excerpt
          className="line-clamp-3 border-l-2 border-[var(--vds-divider-default)] pl-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)] [overflow-wrap:anywhere]"
        >
          {excerpt}
        </span>
      )}
      {status && (
        <span
          role="status"
          className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
        >
          {status}
        </span>
      )}
    </span>
  )
}

function SourceIdentity({
  source,
  image,
  compact = false,
}: {
  image?: string
  compact?: boolean
  source?:
    | CitationIdentity
    | Extract<AnswerSource, { kind: 'searched' }>
    | Extract<AnswerSource, { kind: 'project' }>
}): React.JSX.Element {
  if (source && 'kind' in source && source.kind === 'searched') {
    return (
      <Avatar
        aria-hidden
        image={image}
        fallback={
          <Globe className={compact ? 'size-[var(--vds-icon-6)]' : 'size-[var(--vds-icon-8)]'} />
        }
        data-citation-icon={source.search_kind === 'paper' ? 'paper' : 'web'}
        className={
          compact
            ? '!size-[var(--vds-icon-7)] p-[var(--vds-border-width-1)] !bg-[var(--vds-surface-raised)] text-[var(--vds-text-tertiary)] ring-[length:calc(var(--vds-border-width-1)/2)] ring-inset ring-[var(--vds-divider-default)]'
            : '!size-[var(--vds-icon-8)] !bg-[var(--vds-surface-raised)] text-[var(--vds-text-tertiary)]'
        }
      />
    )
  }
  const name = source?.path || source?.title || ''
  const literature =
    !source ||
    ('source_kind' in source && source.source_kind === 'literature') ||
    ('bibliography' in source && Boolean(source.bibliography))
  return (
    <span
      data-citation-icon={literature ? 'paper' : 'file'}
      className={
        compact
          ? 'inline-flex size-[var(--vds-icon-7)] shrink-0 items-center justify-center'
          : 'inline-flex size-[var(--vds-icon-8)] shrink-0 items-center justify-center'
      }
    >
      <FileFormatIcon
        name={name}
        source={literature ? 'literature' : undefined}
        className={hasFileFormatAsset(name) ? '!size-full' : FILE_FALLBACK_ICON_CLASS_NAME}
      />
    </span>
  )
}

function citationLabel(node: React.ReactNode): string {
  return React.Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      return React.isValidElement<{ children?: React.ReactNode }>(child)
        ? citationLabel(child.props.children)
        : ''
    })
    .join('')
}

function EvidenceContent({
  source,
  previewUrl: resolvePreviewUrl,
}: {
  source: CitationResolution
  previewUrl: (source: CitationResolution) => string
}): React.JSX.Element {
  const { citationText } = useCitationText()
  const [imageFailed, setImageFailed] = useState(false)
  const previewUrl = resolvePreviewUrl(source)
  const previewPage = source.presentation.page
  if (source.presentation.mode === 'structured_text') {
    return (
      <blockquote className="mx-0 mb-0 mt-[var(--vds-space-3)] max-h-[var(--vds-assistant-citation-list-max-height)] overflow-auto whitespace-pre-line [overflow-wrap:break-word] border-0 border-citationText border-solid border-[var(--vds-divider-default)] pt-[var(--vds-space-3)] text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-assistant-citation-line-height)] text-[var(--vds-text-secondary)]">
        <mark className="rounded-[var(--vds-radius-2)] bg-[var(--vds-brand-bg-light)] px-[var(--vds-space-1)] text-inherit">
          {source.presentation.text}
        </mark>
      </blockquote>
    )
  }
  if (
    source.presentation.mode === 'region_image' &&
    previewUrl &&
    previewPage != null &&
    !imageFailed
  ) {
    return (
      <div className="mt-[var(--vds-space-3)] grid gap-[var(--vds-space-2)] border-citationText border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]">
        <img
          src={previewUrl}
          crossOrigin="use-credentials"
          loading="lazy"
          onError={() => setImageFailed(true)}
          alt={citationText('citations.evidenceImageAlt', { page: previewPage })}
          className="max-h-[var(--vds-assistant-citation-expanded-max-height)] w-full rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] object-contain"
        />
        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
          <Badge size="sm" tone="warning">
            {citationText('citations.manualCheck')}
          </Badge>
          {source.presentation.precision === 'page' && (
            <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {citationText('citations.pageOnly')}
            </span>
          )}
        </div>
      </div>
    )
  }
  return (
    <Alert
      className="mt-[var(--vds-space-3)]"
      tone="warning"
      description={citationText('citations.displayUnavailable')}
    />
  )
}

function CitationExcerpt({
  source,
  grouped,
  directory = false,
  onOpenOriginal,
  openTrigger,
  opening = false,
}: {
  source: CitationResolution
  grouped: boolean
  directory?: boolean
  onOpenOriginal?: () => void
  openTrigger?: React.Ref<HTMLButtonElement>
  opening?: boolean
}): React.JSX.Element {
  const { citationText, pageLabel } = useCitationText()
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const excerptRef = useRef<HTMLSpanElement>(null)
  const excerptId = useId()
  const pages = pageLabel(source.pages)
  const separatePageLabel = Boolean(pages) && source.path.toLowerCase().endsWith('.pdf')
  const borderOnExcerpt = directory || separatePageLabel
  const excerptBorder = `border-l-2 border-[var(--vds-divider-default)] ${grouped && !directory ? 'pl-[calc(var(--vds-space-3)/2)]' : 'pl-[var(--vds-space-2)]'}`
  const text = source.presentation.text.trim() || source.quote.trim()
  useLayoutEffect(() => {
    const excerpt = excerptRef.current
    if (!excerpt || expanded) return
    const measure = (): void => setCollapsible(excerpt.scrollHeight > excerpt.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(excerpt)
    document.fonts.addEventListener('loadingdone', measure)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', measure)
    }
  }, [text, grouped, expanded])
  const pageCaption = pages && (
    <span
      className={`block text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] ${directory ? 'text-[var(--vds-text-placeholder)]' : 'text-[var(--vds-text-tertiary)]'} mb-[var(--vds-space-2)]`}
    >
      {pages}
    </span>
  )
  const content = (
    <>
      {pageCaption}
      <span
        id={excerptId}
        ref={excerptRef}
        data-citation-excerpt
        className={`whitespace-pre-line [overflow-wrap:anywhere] ${expanded ? 'block' : 'line-clamp-[var(--vds-assistant-citation-excerpt-collapsed-lines)]'} ${borderOnExcerpt ? excerptBorder : ''}`}
      >
        {text || citationText('citations.displayUnavailable')}
      </span>
    </>
  )
  return (
    <blockquote
      className={`m-0 grid min-w-0 gap-[var(--vds-space-1)] ${onOpenOriginal ? `hover:bg-[var(--vds-other-overlay-1)] ${directory ? 'rounded-[var(--vds-radius-4)]' : 'rounded-[var(--vds-radius-2)]'}` : ''} ${borderOnExcerpt ? '' : excerptBorder} text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)] [font-weight:var(--vds-fw-regular)] ${grouped ? 'leading-[var(--vds-lh-body-lv1)]' : 'leading-[var(--vds-lh-body-lv2)]'}`}
    >
      {onOpenOriginal ? (
        <Button
          ref={openTrigger}
          unstyled
          disabled={opening}
          aria-busy={opening}
          className={`block w-full min-w-0 cursor-pointer px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-left focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)] ${directory ? 'rounded-[var(--vds-radius-4)]' : 'rounded-[var(--vds-radius-2)]'}`}
          onClick={onOpenOriginal}
        >
          {content}
        </Button>
      ) : (
        <div className="min-w-0">{content}</div>
      )}
      {collapsible && (
        <Button
          unstyled
          className={`inline-flex cursor-pointer items-center gap-[var(--vds-space-1)] justify-self-start rounded-[var(--vds-radius-2)] [font:inherit] text-inherit no-underline focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)] [&_svg]:size-[var(--vds-icon-6)] ${onOpenOriginal ? 'ml-[var(--vds-space-2)]' : 'hover:bg-[var(--vds-other-overlay-1)]'} ${borderOnExcerpt ? `${excerptBorder} !border-transparent relative before:pointer-events-none before:absolute before:left-[calc(-1*var(--vds-border-width-2))] before:bottom-0 before:w-[var(--vds-border-width-2)] before:bg-[var(--vds-divider-default)] ${onOpenOriginal ? 'before:-top-[calc(var(--vds-space-1)*2)]' : 'before:-top-[var(--vds-space-1)]'}` : ''}`}
          aria-controls={excerptId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {citationText(expanded ? 'citations.collapseExcerpt' : 'citations.expandExcerpt')}
          {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </Button>
      )}
    </blockquote>
  )
}

function SourcePreview({
  source,
  onOpenOriginal,
  excerpts,
  grouped = false,
}: {
  source: CitationResolution
  onOpenOriginal: (resolve?: CitationTarget['resolve']) => void
  excerpts?: readonly CitationTarget[]
  grouped?: boolean
}): React.JSX.Element {
  const { citationText, statuses, attribution } = useCitationText()
  const { byline } = attribution(source.bibliography)
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-2)] text-left">
      <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-3)]">
        <Button
          unstyled
          className={`${CITATION_PREVIEW_TITLE_CLASS} flex-1 cursor-pointer whitespace-normal break-words rounded-[var(--vds-radius-2)] hover:text-[var(--vds-brand-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)] ${grouped ? 'leading-[var(--vds-space-5)]' : 'leading-[var(--vds-lh-body-lv2)]'}`}
          title={source.title}
          onClick={() => onOpenOriginal()}
        >
          {source.title}
        </Button>
        {!grouped && (
          <Badge
            size="sm"
            tone="neutral"
            className={CITATION_TYPE_CLASS}
            title={source.source_kind}
          >
            {citationText(citationSourceType(source.source_kind).labelKey)}
          </Badge>
        )}
      </div>
      {byline && (
        <p className={`m-0 ${CITATION_ATTRIBUTION_CLASS}`} title={source.bibliography?.authors}>
          {byline}
        </p>
      )}
      {(excerpts?.length ? excerpts : [{ source }]).map((target) => {
        const excerptSource = target.source.handle === source.handle ? source : target.source
        return (
          <CitationExcerpt
            key={excerptSource.handle}
            source={excerptSource}
            grouped={grouped}
            onOpenOriginal={
              excerpts && excerpts.length > 1 && 'resolve' in target
                ? () => onOpenOriginal(target.resolve)
                : undefined
            }
          />
        )
      })}
      {(source.state === 'changed' || source.state === 'unavailable') && (
        <p
          role="status"
          className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {source.source_missing ? citationText('citations.fileMissing') : statuses[source.state]}
        </p>
      )}
    </div>
  )
}
export function CitationLink({
  resolve,
  reveal,
  previewUrl,
  isUnverifiable,
  children,
  displayNumber,
  onResolved,
  identity,
  directorySource,
  directory = false,
  directoryPart,
  references,
}: {
  resolve: () => Promise<CitationResolution>
  reveal: (source: CitationResolution) => Promise<void>
  previewUrl: (source: CitationResolution) => string
  isUnverifiable?: (error: unknown) => boolean
  children: React.ReactNode
  displayNumber?: number
  onResolved?: (source: CitationResolution) => void
  identity?: CitationIdentity
  directorySource?: CitationResolution
  directory?: boolean
  directoryPart?: 'first' | 'excerpt'
  references?: readonly CitationReference[]
}): React.JSX.Element {
  const { citationText, statuses, location, format, attribution } = useCitationText()
  const trigger = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const inspection = useRef(0)
  const [page, setPage] = useState(0)
  const currentPage = Math.min(page, Math.max(0, (references?.length ?? 1) - 1))
  const reference = references?.[currentPage]
  const grouped = (references?.length ?? 0) > 1
  const resolveCurrent = reference?.resolve ?? resolve
  const firstSource = references?.[0]?.source
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<CitationResolution>()
  const [error, setErrorCode] = useState<'sourceChanged' | 'unverifiable' | 'openFailed' | ''>('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<CitationResolution>()
  const [previewError, setPreviewError] = useState<'loadFailed' | 'unverifiable' | ''>('')
  const errorText = {
    sourceChanged: citationText('citations.error.sourceChanged'),
    unverifiable: citationText('citations.error.unverifiable'),
    openFailed: citationText('citations.error.openFailed'),
  }
  const markerSource =
    firstSource ?? identity ?? (preview?.source_kind === 'literature' ? preview : undefined)
  const literature =
    markerSource?.source_kind === 'literature' || Boolean(markerSource?.bibliography)
  const { author, year } = attribution(markerSource?.bibliography)
  const markerTitle = (literature && author) || markerSource?.title || children
  const label =
    markerSource?.title ??
    (displayNumber === undefined ? citationLabel(children) : String(displayNumber))
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const inspect = async (next: boolean, index = currentPage): Promise<void> => {
    const request = ++inspection.current
    setPreviewOpen(next)
    if (!next) return
    setPreviewError('')
    try {
      const source = await (references?.[index]?.resolve ?? resolve)()
      if (mounted.current && inspection.current === request) {
        setPreview(source)
        onResolved?.(source)
      }
    } catch (error) {
      if (mounted.current && inspection.current === request)
        setPreviewError(isUnverifiable?.(error) ? 'unverifiable' : 'loadFailed')
    }
  }
  const selectPage = (index: number): void => {
    if (index < 0 || index >= (references?.length ?? 1) || index === currentPage) return
    setPage(index)
    setPreview(references?.[index]?.source)
    void inspect(true, index)
  }
  const close = (): void => {
    setProblem(undefined)
    setErrorCode('')
    trigger.current?.focus({ preventScroll: true })
  }
  const open = async (resolveTarget = resolveCurrent): Promise<void> => {
    inspection.current += 1
    setPreviewOpen(false)
    setLoading(true)
    setErrorCode('')
    let source: CitationResolution | undefined
    try {
      source = await resolveTarget()
      if (!mounted.current) return
      if (resolveTarget === resolveCurrent) setPreview(source)
      onResolved?.(source)
      if (!source.version_bound || (source.state !== 'exact' && source.state !== 'source_only')) {
        setProblem(source)
        return
      }
      await reveal(source)
      if (mounted.current) setProblem(undefined)
    } catch {
      if (mounted.current) {
        if (source) setProblem(source)
        setErrorCode(source ? 'sourceChanged' : 'unverifiable')
      }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }
  const currentSource = preview ?? directorySource
  const directoryExcerpt = Boolean(
    directoryPart || (currentSource?.source_kind === 'literature' && currentSource.pages.length)
  )
  const marker = (
    <CitationMarker
      ref={trigger}
      label={label}
      disabled={loading}
      aria-busy={loading}
      className={
        directory
          ? SOURCE_DIRECTORY_CLASS
          : literature
            ? `${CITATION_MARKER_CLASS} !max-w-[min(100%,var(--vds-assistant-literature-citation-marker-max-width))]`
            : CITATION_MARKER_CLASS
      }
      data-citation-source-card={directory || undefined}
      aria-label={citationText('citations.view', { label })}
      onClick={() => void open()}
    >
      {directory ? (
        <SourceDirectoryContent
          title={children}
          attribution={attribution(currentSource?.bibliography).byline}
          excerpt={
            directoryExcerpt
              ? undefined
              : currentSource?.presentation.text.trim() || currentSource?.quote.trim()
          }
          typeLabel={
            currentSource
              ? citationText(citationSourceType(currentSource.source_kind).labelKey)
              : citationText('citations.unknownSource')
          }
          details={currentSource ? location(currentSource) : citationText('citations.loading')}
          status={
            currentSource &&
            (currentSource.state === 'changed' || currentSource.state === 'unavailable')
              ? statuses[currentSource.state]
              : undefined
          }
        />
      ) : (
        <>
          <SourceIdentity source={markerSource} compact />
          <CitationMarkerTitle title={markerTitle} file={!literature} />
          {literature && year && <span className="shrink-0">{year}</span>}
          {references && references.length > 1 && (
            <span className="shrink-0 text-[var(--vds-text-placeholder)]">
              +{format.number(references.length - 1)}
            </span>
          )}
        </>
      )}
    </CitationMarker>
  )
  return (
    <>
      {directory ? (
        <>
          {(directoryPart !== 'excerpt' || !currentSource) && marker}
          {directoryExcerpt && currentSource && (
            <CitationExcerpt
              source={currentSource}
              grouped
              directory
              onOpenOriginal={() => void open()}
              openTrigger={directoryPart === 'excerpt' ? trigger : undefined}
              opening={loading}
            />
          )}
        </>
      ) : (
        <HoverCard
          open={previewOpen}
          onOpenChange={(value) => {
            if (value) {
              setPage(0)
              if (references) setPreview(firstSource)
            }
            void inspect(value, value ? 0 : currentPage)
          }}
        >
          <HoverCardTrigger asChild>{marker}</HoverCardTrigger>
          <HoverCardContent
            hosted
            aria-label={citationText('citations.preview')}
            onKeyDown={(event) => {
              if (
                !references ||
                references.length < 2 ||
                !['ArrowLeft', 'ArrowRight'].includes(event.key)
              )
                return
              event.preventDefault()
              event.stopPropagation()
              selectPage(currentPage + (event.key === 'ArrowRight' ? 1 : -1))
            }}
            className={
              grouped
                ? `${CITATION_PREVIEW_SURFACE_CLASS} !w-[var(--vds-assistant-citation-group-width)] !max-w-[var(--vds-popover-available-width)] !rounded-[var(--vds-radius-6)]`
                : CITATION_PREVIEW_CLASS
            }
          >
            {references && references.length > 1 && (
              <div className="flex items-center gap-[var(--vds-space-3)] border-b border-[var(--vds-divider-default)] pb-[var(--vds-space-2)]">
                <IconButton
                  label={citationText('citations.previousSource')}
                  icon={<IconFont type="icon-a-line-switch-arrow-left-s" />}
                  className={CITATION_NAVIGATION_CLASS}
                  size="xs"
                  variant="ghostIcon"
                  disabled={currentPage === 0}
                  onClick={() => selectPage(currentPage - 1)}
                />
                <IconButton
                  label={citationText('citations.nextSource')}
                  icon={<IconFont type="icon-a-line-switch-arrow-right-s" />}
                  className={CITATION_NAVIGATION_CLASS}
                  size="xs"
                  variant="ghostIcon"
                  disabled={currentPage === references.length - 1}
                  onClick={() => selectPage(currentPage + 1)}
                />
                <span className="ml-auto text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)]">
                  {citationText('citations.sourceCount', {
                    count: references.length,
                    formattedCount: format.number(references.length),
                  })}
                </span>
              </div>
            )}
            {previewError && preview && (
              <p
                role="status"
                className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
              >
                {citationText('citations.stalePreview')}
              </p>
            )}
            {preview ? (
              <SourcePreview
                source={preview}
                grouped={grouped}
                excerpts={reference?.excerpts}
                onOpenOriginal={(resolveTarget) => void open(resolveTarget)}
              />
            ) : (
              <p
                role="status"
                className="m-0 text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]"
              >
                {previewError === 'unverifiable'
                  ? citationText('citations.previewUnverifiable')
                  : previewError
                    ? citationText('citations.previewFailed')
                    : citationText('citations.loading')}
              </p>
            )}
          </HoverCardContent>
        </HoverCard>
      )}
      {(problem || error) && (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value) close()
          }}
        >
          <DialogPortal>
            <DialogContent aria-label={citationText('citations.state')}>
              <DialogHeader>
                <DialogTitle>{problem?.title ?? citationText('citations.openTitle')}</DialogTitle>
              </DialogHeader>
              {problem && (
                <>
                  <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
                    {location(problem)} ·{' '}
                    {problem.source_missing
                      ? citationText('citations.fileMissing')
                      : statuses[problem.state]}
                  </p>
                  {problem.state === 'unavailable' && problem.quote ? (
                    <blockquote className="whitespace-pre-line text-[var(--vds-text-secondary)]">
                      {problem.quote}
                    </blockquote>
                  ) : (
                    <EvidenceContent source={problem} previewUrl={previewUrl} />
                  )}
                </>
              )}
              {error && <p role="alert">{errorText[error]}</p>}
              {problem?.can_open_pdf && problem.state === 'source_only' && (
                <Button
                  onClick={() => void reveal(problem).catch(() => setErrorCode('openFailed'))}
                >
                  {citationText('citations.openPdf')}
                </Button>
              )}
              <Button disabled={loading} aria-busy={loading} onClick={() => void open()}>
                {loading ? citationText('citations.checking') : citationText('citations.check')}
              </Button>
              <Button variant="secondary" onClick={close}>
                {citationText('citations.close')}
              </Button>
            </DialogContent>
          </DialogPortal>
        </Dialog>
      )}
    </>
  )
}

function webSourceLabel(source: Extract<AnswerSource, { kind: 'searched' }>) {
  if (source.search_kind === 'paper') return 'citations.paperSearchSource' as const
  if (source.evidence?.some((evidence) => evidence.origin === 'page'))
    return 'citations.pageEvidenceSource' as const
  if (source.origin === 'tool_declared' || !source.search_id)
    return 'citations.declaredSource' as const
  return 'citations.webSearchSource' as const
}

function webCitationDomain(source: Extract<AnswerSource, { kind: 'searched' }>): string {
  try {
    return new URL(source.url).hostname
  } catch {
    return citationDisplay(source).url
  }
}

type WebPreviewLoader = (
  url: string,
  signal: AbortSignal
) => Promise<{ title: string; description: string; abstract?: string }>

function WebSourcePreview({
  source,
  open,
  loadPreview,
  onOpen,
  sourceIconUrl,
}: {
  source: Extract<AnswerSource, { kind: 'searched' }>
  open: boolean
  loadPreview?: WebPreviewLoader
  onOpen: () => void
  sourceIconUrl?: (url: string) => string | undefined
}): React.JSX.Element {
  const { citationText } = useCitationText()
  const [preview, setPreview] = useState<Awaited<ReturnType<WebPreviewLoader>>>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open || !loadPreview || preview) return
    const controller = new AbortController()
    setFailed(false)
    void loadPreview(source.url, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [open, loadPreview, source.url, preview])
  const summary = preview?.abstract || source.description || source.excerpt || preview?.description
  return (
    <Button
      unstyled
      className="group grid w-full cursor-pointer gap-[calc(var(--vds-space-3)/2)] rounded-[var(--vds-radius-3)] py-[var(--vds-space-2)] text-left [font-weight:var(--vds-fw-regular)] focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)]"
      onClick={onOpen}
    >
      <span className="flex min-w-0 items-center gap-[calc(var(--vds-space-3)/2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
        <SourceIdentity source={source} image={sourceIconUrl?.(source.url)} compact />
        <span data-citation-source-domain className="min-w-0 flex-1 truncate">
          {webCitationDomain(source)}
        </span>
        <Badge size="sm" tone="neutral" className={CITATION_TYPE_CLASS}>
          {citationText(
            source.search_kind === 'paper' ? 'citations.paperSource' : 'citations.webSource'
          )}
        </Badge>
      </span>
      <span
        data-citation-source-title
        className="text-[length:var(--vds-font-body-lv2)] [font-weight:var(--vds-fw-semibold)] leading-[var(--vds-assistant-source-title-line-height)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere] group-hover:text-[var(--vds-brand-text-primary)]"
      >
        {preview?.title || citationDisplay(source).title}
      </span>
      {summary && (
        <span className="break-words text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
          {summary}
        </span>
      )}
      {failed && <span role="status">{citationText('citations.webPreviewUnavailable')}</span>}
    </Button>
  )
}

export function WebCitationLink({
  source,
  additionalSources = [],
  loadPreview,
  openWebSource,
  directory = false,
  sourceIconUrl,
}: {
  source: Extract<AnswerSource, { kind: 'searched' }>
  additionalSources?: readonly Extract<AnswerSource, { kind: 'searched' }>[]
  loadPreview?: WebPreviewLoader
  openWebSource: (url: string) => void
  directory?: boolean
  sourceIconUrl?: (url: string) => string | undefined
}): React.JSX.Element {
  const { citationText, format } = useCitationText()
  const [open, setOpen] = useState(false)
  const label = citationDisplay(source).title
  const domain = webCitationDomain(source)
  const remaining = additionalSources.length
  const marker = (
    <CitationMarker
      label={label}
      className={directory ? SOURCE_DIRECTORY_CLASS : CITATION_MARKER_CLASS}
      data-citation-source-card={directory || undefined}
      onClick={(event) => {
        event.preventDefault()
        setOpen(false)
        openWebSource(source.url)
      }}
      aria-label={citationText('citations.view', { label })}
    >
      {directory ? (
        <span className="flex min-w-0 w-full items-center gap-[var(--vds-space-2)]">
          <SourceIdentity source={source} image={sourceIconUrl?.(source.url)} compact />
          <span className="grid min-w-0 gap-[var(--vds-space-1)]">
            <span
              data-citation-source-title
              className="truncate text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-assistant-source-title-line-height)] text-[var(--vds-text-primary)]"
            >
              {label}
            </span>
            <span
              data-citation-source-domain
              title={citationText(webSourceLabel(source))}
              className="truncate text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
            >
              {domain}
            </span>
          </span>
        </span>
      ) : (
        <>
          <SourceIdentity source={source} image={sourceIconUrl?.(source.url)} compact />
          <span className="min-w-0 truncate">{citationOrigin(source.url)?.label ?? domain}</span>
          {remaining > 0 && (
            <span className="shrink-0 text-[var(--vds-text-placeholder)]">
              +{format.number(remaining)}
            </span>
          )}
        </>
      )}
    </CitationMarker>
  )
  if (directory) return marker
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{marker}</HoverCardTrigger>
      <HoverCardContent
        hosted
        aria-label={citationText('citations.webPreview')}
        className="!w-[var(--vds-assistant-source-list-width)] !max-w-[var(--vds-popover-available-width)] rounded-[var(--vds-radius-6)] border-0 bg-[var(--vds-surface-raised)] p-[var(--vds-space-3)] !shadow-[var(--vds-shadow-2-center)] [font-weight:var(--vds-fw-regular)]"
      >
        <ScrollArea viewportClassName="max-h-[var(--vds-assistant-citation-expanded-max-height)]">
          {[source, ...additionalSources].map((item) => (
            <WebSourcePreview
              key={item.url}
              source={item}
              open={open}
              loadPreview={loadPreview}
              sourceIconUrl={sourceIconUrl}
              onOpen={() => {
                setOpen(false)
                openWebSource(item.url)
              }}
            />
          ))}
        </ScrollArea>
      </HoverCardContent>
    </HoverCard>
  )
}

export function CitationSources({
  sourceKey,
  loadSources,
  resolveSource,
  reveal,
  previewUrl,
  isUnverifiable,
  openWebSource,
  answerSources,
  renderProjectSource,
  coverage,
  sourceIconUrl,
}: {
  sourceKey: string
  loadSources?: () => Promise<{ count: number; sources: CitationResolution[] }>
  resolveSource: (handle: string) => Promise<CitationResolution>
  reveal: (source: CitationResolution) => Promise<void>
  previewUrl: (source: CitationResolution) => string
  isUnverifiable?: (error: unknown) => boolean
  openWebSource: (url: string) => void
  answerSources?: AnswerSource[]
  renderProjectSource?: (source: Extract<AnswerSource, { kind: 'project' }>) => React.ReactNode
  coverage?: AnswerCoverage
  sourceIconUrl?: (url: string) => string | undefined
}): React.JSX.Element | null {
  const { citationText, format } = useCitationText()
  const [result, setResult] = useState<{ count: number; sources: CitationResolution[] }>()
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [scrollbarVisible, setScrollbarVisible] = useState(false)
  const [scrollbar] = useState(() =>
    createScrollbarVisibility(
      setScrollbarVisible,
      (callback, delay) => window.setTimeout(callback, delay),
      (timer) => window.clearTimeout(timer)
    )
  )
  useEffect(() => scrollbar.hide, [scrollbar, sourceKey])
  useEffect(() => {
    setResult(undefined)
    setDirectoryOpen(false)
  }, [sourceKey])
  useEffect(() => {
    let current = true
    setError(false)
    if (loadSources)
      void loadSources()
        .then((value) => {
          if (current) setResult(value)
        })
        .catch(() => {
          if (current) setError(true)
        })
    return () => {
      current = false
    }
  }, [sourceKey, refresh, loadSources])
  if (error && !result && !answerSources?.length)
    return (
      <p
        role="status"
        className="mt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
      >
        {citationText('citations.listFailed')}
      </p>
    )
  const projected =
    answerSources ??
    result?.sources.map((source, index) => ({
      number: index + 1,
      kind: 'receipt' as const,
      handle: source.handle,
      citation_urls: [],
    })) ??
    []
  const resolved = new Map(result?.sources.map((source) => [source.handle, source]))
  const groups = groupCitationSources(projected, result?.sources ?? [])
  if (!groups.length && !coverage) return null
  const totalLabel = citationText('citations.sourceCount', {
    count: groups.length,
    formattedCount: format.number(groups.length),
  })
  const reviewing = coverage && COVERAGE_PROGRESS_STATUSES.has(coverage.status)
  const coverageMessage = coverage && citationText(COVERAGE_MESSAGE_KEYS[coverage.status])
  const showAnswerStatus =
    coverage && (reviewing || (!groups.length && coverage.status !== 'reviewed'))
  const sourceList = (
    <ScrollArea
      overlay
      className="flex min-h-0 flex-col -mr-[var(--vds-space-2)] [--vds-overlay-scrollbar-size:var(--vds-assistant-source-list-scrollbar-width)]"
      viewportProps={{ role: 'list', 'aria-label': totalLabel }}
      viewportClassName="min-h-0 flex-1 pr-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)] [&>div]:gap-[var(--vds-space-2)]"
    >
      {groups.map((group) => (
        <div
          key={group.key}
          role="listitem"
          data-citation-source-entry
          className="grid min-w-0 rounded-[var(--vds-radius-4)] text-[length:var(--vds-font-body-lv2)]"
        >
          {(group.sources[0].kind !== 'receipt'
            ? group.sources.slice(0, 1)
            : [...group.sources].sort((left, right) => {
                const firstPage = (source: AnswerSource) =>
                  (source.kind === 'receipt' && resolved.get(source.handle)?.pages[0]?.page) ||
                  Number.MAX_SAFE_INTEGER
                return firstPage(left) - firstPage(right)
              })
          ).map((source, index) => {
            const pdf = source.kind === 'receipt' ? resolved.get(source.handle) : undefined
            return (
              <React.Fragment key={source.kind === 'receipt' ? source.handle : source.number}>
                <span className="sr-only">
                  [
                  {source.kind !== 'receipt'
                    ? group.sources.map((item) => item.number).join('、')
                    : source.number}
                  ]
                </span>
                <div className="min-w-0">
                  {source.kind === 'searched' ? (
                    <>
                      <WebCitationLink
                        source={source}
                        directory
                        sourceIconUrl={sourceIconUrl}
                        openWebSource={(url) => {
                          setDirectoryOpen(false)
                          openWebSource(url)
                        }}
                      />
                    </>
                  ) : source.kind === 'project' ? (
                    <>
                      {renderProjectSource?.(source) ?? source.title}
                      <p className="my-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                        {citationText('citations.projectNavigationSource')}
                      </p>
                    </>
                  ) : (
                    <>
                      <CitationLink
                        identity={pdf}
                        directorySource={pdf}
                        directory
                        directoryPart={
                          group.sources.length > 1 ? (index === 0 ? 'first' : 'excerpt') : undefined
                        }
                        resolve={() => resolveSource(source.handle)}
                        reveal={reveal}
                        previewUrl={previewUrl}
                        isUnverifiable={isUnverifiable}
                        onResolved={(updated) =>
                          setResult((current) =>
                            current
                              ? {
                                  ...current,
                                  sources: current.sources.map((item) =>
                                    item.handle === updated.handle ? updated : item
                                  ),
                                }
                              : { count: 1, sources: [updated] }
                          )
                        }
                      >
                        {pdf?.title ?? citationText('citations.loading')}
                      </CitationLink>
                    </>
                  )}
                </div>
              </React.Fragment>
            )
          })}
        </div>
      ))}
    </ScrollArea>
  )
  return (
    <div className="mt-[var(--vds-space-3)]" data-answer-source-list>
      {showAnswerStatus && coverage && (
        <p
          role="status"
          className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {coverage.status === 'partial'
            ? citationText('citations.noAssociatedSources')
            : coverageMessage}
        </p>
      )}
      {groups.length > 0 && (
        <Popover
          open={directoryOpen}
          onOpenChange={(open) => {
            setDirectoryOpen(open)
            if (open) setRefresh((value) => value + 1)
            else scrollbar.hide()
          }}
        >
          <PopoverTrigger asChild>
            <Button
              unstyled
              className="inline-flex max-w-full cursor-pointer items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-6)] border-0 bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] [font-weight:var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)] hover:bg-[var(--vds-other-overlay-2)] focus-visible:ring-2 focus-visible:ring-[var(--vds-brand-text-primary)]"
            >
              <span
                aria-hidden
                className="flex shrink-0 -space-x-[calc(var(--vds-space-3)/2+var(--vds-space-1))]"
                data-citation-source-icons
              >
                {groups.slice(0, SOURCE_ICON_LIMIT).map((group) => {
                  const first = group.sources[0]
                  const website = first.kind === 'searched' && first.search_kind !== 'paper'
                  return (
                    <span
                      key={group.key}
                      className={`inline-flex size-[var(--vds-icon-8)] items-center justify-center overflow-hidden rounded-[var(--vds-radius-pill)] bg-[var(--vds-surface-raised)] ring-[length:calc(var(--vds-border-width-1)/2)] ring-inset ring-[var(--vds-divider-default)] ${website ? '' : 'p-[calc(var(--vds-space-3)/4)] [&>[data-citation-icon]]:!size-full [&_svg]:max-h-full [&_svg]:max-w-full'}`}
                    >
                      <SourceIdentity
                        source={first.kind !== 'receipt' ? first : resolved.get(first.handle)}
                        image={first.kind === 'searched' ? sourceIconUrl?.(first.url) : undefined}
                      />
                    </span>
                  )
                })}
              </span>
              <span className="text-[var(--vds-text-secondary)]">{totalLabel}</span>
              {directoryOpen ? (
                <ChevronDown
                  aria-hidden="true"
                  className="size-[calc(var(--vds-space-2)+var(--vds-space-half))] shrink-0"
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  className="size-[calc(var(--vds-space-2)+var(--vds-space-half))] shrink-0"
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            hosted
            data-citation-source-panel
            onScrollCapture={scrollbar.scroll}
            onPointerLeave={scrollbar.hide}
            className={[
              'flex! max-h-[var(--vds-assistant-source-list-height)] !w-[var(--vds-assistant-source-list-width)] max-w-[var(--vds-popover-available-width)] flex-col overflow-hidden rounded-[var(--vds-radius-6)] border-0 bg-[var(--vds-surface-raised)] p-[var(--vds-space-2)] shadow-[var(--vds-shadow-2-center)]',
              !scrollbarVisible && '[&_[data-scroll-thumb]]:opacity-0',
            ].join(' ')}
          >
            {sourceList}
            {error && (
              <p
                role="status"
                className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
              >
                {citationText('citations.staleList')}
              </p>
            )}
            {coverage && !reviewing && (
              <div
                role="note"
                className="mt-[var(--vds-space-2)] space-y-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
              >
                <p>
                  {coverage.status === 'partial'
                    ? citationText('citations.noAssociatedSources')
                    : coverageMessage}
                </p>
                {!!coverage.unread_sources && (
                  <p>
                    {citationText('citations.unreadCandidates', { count: coverage.unread_sources })}
                  </p>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
