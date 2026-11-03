import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_LANGUAGE } from '../../../../localization/catalog'
import { createFormatters } from '../../../../localization/format'
import type { PreferenceLanguage } from '../../../../preferences'

import iconPdf from '../../assets/icon-pdf.png'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui'
import type { CitationResolution } from '../../contracts/citations'
import { Icon } from '../../icons'
import type { AnswerCoverage, AnswerSource } from '../../model'
import { citationDisplay } from '../../features/assistant/display'

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
  }
  const location = (source: CitationResolution): string =>
    citationText('citations.location', {
      pages: source.pages.length
        ? citationText('citations.pages', {
            pages: source.pages
              .map((page) => format.number(page.page))
              .join(citationText('citations.pageSeparator')),
          })
        : citationText('citations.noPages'),
      content: contentLabels[source.content_level] ?? source.content_level,
    })
  return { citationText, statuses, location, format }
}
const CITATION_NUMBER = /^\d+$/
const CITATION_JOINER = '\u2060'
const COVERAGE_PROGRESS_STATUSES = new Set<AnswerCoverage['status']>(['pending', 'reviewing'])
const COVERAGE_MESSAGE_KEYS = {
  pending: 'citations.coverage.pending',
  reviewing: 'citations.coverage.reviewing',
  reviewed: 'citations.coverage.reviewed',
  partial: 'citations.coverage.partial',
  unavailable: 'citations.coverage.unavailable',
  interrupted: 'citations.coverage.interrupted',
} as const
const NUMBERED_CITATION_CLASS =
  'inline cursor-pointer align-super text-[length:var(--vds-assistant-citation-font-scale)] font-[var(--vds-fw-semibold)] leading-none text-[var(--accent-ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)]'
const NAMED_CITATION_CLASS =
  'inline max-w-full cursor-pointer whitespace-normal [overflow-wrap:anywhere] rounded-[var(--vds-radius-1)] text-left font-[var(--vds-fw-semibold)] text-[var(--accent-ink)] underline decoration-[var(--vds-border-default)] underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)]'

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

function SourcePreview({
  source,
  onOpenOriginal,
  previewUrl,
}: {
  source: CitationResolution
  previewUrl: (source: CitationResolution) => string
  onOpenOriginal?: () => void
}): React.JSX.Element {
  const { citationText, statuses, location } = useCitationText()
  return (
    <div className="relative pl-[var(--vds-space-6)] text-left">
      <img
        src={iconPdf}
        alt=""
        className="absolute left-0 top-[var(--vds-space-half)] size-[var(--vds-space-4)] object-contain"
      />
      <div className="min-w-0">
        <p className="m-0 [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-assistant-citation-line-height)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
          {source.title}
        </p>
        <p className="my-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {location(source)}
        </p>
        <EvidenceContent source={source} previewUrl={previewUrl} />
        {source.state !== 'exact' && (
          <p
            role="status"
            className="mb-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
          >
            {statuses[source.state]}
          </p>
        )}
        {onOpenOriginal && source.can_open_pdf && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-[var(--vds-space-3)]"
            onClick={onOpenOriginal}
          >
            {citationText('citations.viewOriginal')}
          </Button>
        )}
      </div>
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
}: {
  resolve: () => Promise<CitationResolution>
  reveal: (source: CitationResolution) => Promise<void>
  previewUrl: (source: CitationResolution) => string
  isUnverifiable?: (error: unknown) => boolean
  children: React.ReactNode
  displayNumber?: number
  onResolved?: (source: CitationResolution) => void
}): React.JSX.Element {
  const { citationText, statuses, location } = useCitationText()
  const trigger = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
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
  const label = displayNumber === undefined ? citationLabel(children) : String(displayNumber)
  const numbered = CITATION_NUMBER.test(label)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const inspect = async (next: boolean): Promise<void> => {
    setPreviewOpen(next)
    if (!next) return
    setPreviewError('')
    try {
      const source = await resolve()
      if (mounted.current) {
        setPreview(source)
        onResolved?.(source)
      }
    } catch (error) {
      if (mounted.current) setPreviewError(isUnverifiable?.(error) ? 'unverifiable' : 'loadFailed')
    }
  }
  const close = (): void => {
    setProblem(undefined)
    setErrorCode('')
    trigger.current?.focus({ preventScroll: true })
  }
  const open = async (): Promise<void> => {
    setPreviewOpen(false)
    setLoading(true)
    setErrorCode('')
    let source: CitationResolution | undefined
    try {
      source = await resolve()
      if (!mounted.current) return
      setPreview(source)
      onResolved?.(source)
      if (source.can_open_pdf === false || source.state !== 'exact') {
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
  return (
    <>
      <HoverCard open={previewOpen} onOpenChange={(value) => void inspect(value)}>
        <HoverCardTrigger asChild>
          <Button
            ref={trigger}
            unstyled
            disabled={loading}
            aria-busy={loading}
            className={numbered ? NUMBERED_CITATION_CLASS : NAMED_CITATION_CLASS}
            data-citation-state={preview?.state}
            title={
              preview?.state === 'unavailable'
                ? citationText('citations.unavailableTitle')
                : undefined
            }
            aria-label={citationText('citations.view', { label: numbered ? `[${label}]` : label })}
            onClick={() => void open()}
          >
            <span data-citation-label>
              {numbered ? (
                <>
                  <span aria-hidden className="select-none">
                    {CITATION_JOINER}
                  </span>
                  [{label}]
                </>
              ) : (
                children
              )}
            </span>
          </Button>
        </HoverCardTrigger>
        <HoverCardContent
          aria-label={citationText('citations.preview')}
          className="!w-[var(--vds-assistant-citation-panel-width)] !max-w-[var(--vds-assistant-floating-panel-width)] max-h-[var(--vds-assistant-citation-panel-height)] overflow-y-auto rounded-[var(--vds-radius-4)] border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)]"
        >
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
              previewUrl={previewUrl}
              onOpenOriginal={() => {
                setPreviewOpen(false)
                void reveal(preview).catch(() => {
                  setProblem(preview)
                  setErrorCode('openFailed')
                })
              }}
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
                    {location(problem)} · {statuses[problem.state]}
                  </p>
                  <EvidenceContent source={problem} previewUrl={previewUrl} />
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

export function WebCitationLink({
  source,
  named = false,
  openWebSource,
}: {
  source: Extract<AnswerSource, { kind: 'searched' }>
  named?: boolean
  openWebSource: (url: string) => void
}): React.JSX.Element {
  const { citationText } = useCitationText()
  const display = citationDisplay(source)
  const label = named ? display.title : String(source.number)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          unstyled
          className={named ? NAMED_CITATION_CLASS : NUMBERED_CITATION_CLASS}
          aria-label={citationText('citations.view', { label: named ? label : `[${label}]` })}
        >
          <span data-citation-label>
            {named ? (
              label
            ) : (
              <>
                <span aria-hidden className="select-none">
                  {CITATION_JOINER}
                </span>
                [{label}]
              </>
            )}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={citationText('citations.webPreview')}
        className="!w-[var(--vds-assistant-citation-panel-width)] !max-w-[var(--vds-assistant-floating-panel-width)] rounded-[var(--vds-radius-4)] border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)]"
      >
        <div className="flex gap-[var(--vds-space-2)] text-left">
          <Icon name="globe" size={16} />
          <div className="min-w-0">
            <p className="m-0 [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-assistant-citation-line-height)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
              {display.title}
            </p>
            {source.title.trim() !== source.url.trim() && (
              <p className="my-[var(--vds-space-1)] [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                {display.url}
              </p>
            )}
            <p className="my-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {citationText(webSourceLabel(source))}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-[var(--vds-space-2)]"
              onClick={() => openWebSource(source.url)}
            >
              {citationText('citations.viewOriginal')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
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
  coverage,
}: {
  sourceKey: string
  loadSources?: () => Promise<{ count: number; sources: CitationResolution[] }>
  resolveSource: (handle: string) => Promise<CitationResolution>
  reveal: (source: CitationResolution) => Promise<void>
  previewUrl: (source: CitationResolution) => string
  isUnverifiable?: (error: unknown) => boolean
  openWebSource: (url: string) => void
  answerSources?: AnswerSource[]
  coverage?: AnswerCoverage
}): React.JSX.Element | null {
  const { citationText, statuses, location, format } = useCitationText()
  const [result, setResult] = useState<{ count: number; sources: CitationResolution[] }>()
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    setResult(undefined)
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
  if (!projected.length && !coverage) return null
  const resolved = new Map(result?.sources.map((source) => [source.handle, source]))
  const reviewing = coverage && COVERAGE_PROGRESS_STATUSES.has(coverage.status)
  const coverageMessage = coverage && citationText(COVERAGE_MESSAGE_KEYS[coverage.status])
  const showAnswerStatus =
    coverage && (reviewing || (!projected.length && coverage.status !== 'reviewed'))
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
      {projected.length > 0 && (
        <Popover
          onOpenChange={(open) => {
            if (open) setRefresh((value) => value + 1)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              className="gap-[var(--vds-space-2)] rounded-[var(--vds-radius-pill)]"
            >
              <Icon name="link" size={16} />
              {citationText('citations.sourceCount', {
                count: projected.length,
                formattedCount: format.number(projected.length),
              })}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="max-h-[var(--vds-assistant-source-list-height)] !w-[var(--vds-assistant-source-list-width)] overflow-auto rounded-[var(--vds-radius-8)] p-[var(--vds-space-3)]">
            <div
              role="list"
              tabIndex={0}
              aria-label={citationText('citations.sourceCount', {
                count: projected.length,
                formattedCount: format.number(projected.length),
              })}
              className="rounded-[var(--vds-radius-3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)]"
            >
              {projected.map((source) => {
                const pdf = source.kind === 'receipt' ? resolved.get(source.handle) : undefined
                return (
                  <div
                    key={source.kind === 'searched' ? source.url : source.handle}
                    role="listitem"
                    data-citation-source-entry
                    className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] last:border-0"
                  >
                    <span className="font-[var(--vds-fw-semibold)] text-[var(--vds-text-secondary)]">
                      [{source.number}]
                    </span>
                    <div className="min-w-0">
                      {source.kind === 'searched' ? (
                        <>
                          <WebCitationLink source={source} named openWebSource={openWebSource} />
                          {source.title.trim() !== source.url.trim() && (
                            <p className="my-[var(--vds-space-1)] [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                              {citationDisplay(source).url}
                            </p>
                          )}
                          <p className="my-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                            {citationText(webSourceLabel(source))}
                          </p>
                        </>
                      ) : (
                        <>
                          <CitationLink
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
                          {pdf && (
                            <>
                              <p className="my-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                                {location(pdf)}
                              </p>
                              {pdf.state !== 'exact' && (
                                <p
                                  role="status"
                                  className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
                                >
                                  {statuses[pdf.state]}
                                </p>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
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
