import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_LANGUAGE } from '../../../../localization/catalog'
import { createFormatters } from '../../../../localization/format'
import type { PreferenceLanguage } from '../../../../preferences'

import iconPdf from '../../assets/icon-pdf.png'
import { Alert, Badge, Button, Dialog, DialogContent, DialogHeader, DialogPortal, DialogTitle, HoverCard, HoverCardContent, HoverCardTrigger, Popover, PopoverContent, PopoverTrigger } from '../../components/ui'
import type { CitationLinkRange, CitationResolution } from '../../contracts/citations'
import { Icon } from '../../icons'
import type { AnswerSource } from '../../model'
import { useApp } from '../../store'
import { useWorkspaceController } from '../workbench/workspace'
import { sha256Text } from './anchors'
import { citationPreviewUrl, citationSources, isUnverifiableCitationError, resolveCitation } from './api'

function useCitationText() {
  const { t, i18n } = useTranslation('assistant')
  const format = createFormatters((i18n.resolvedLanguage ?? DEFAULT_LANGUAGE) as PreferenceLanguage)
  const statuses = {
    exact: t('citations.status.exact'), source_only: t('citations.status.sourceOnly'),
    unavailable: t('citations.status.unavailable'), changed: t('citations.status.changed')
  }
  const contentLabels: Record<string, string> = {
    selection: t('citations.content.selection'), fulltext: t('citations.content.fulltext'),
    source_excerpt: t('citations.content.sourceExcerpt'), abstract: t('citations.content.abstract'), papercard: t('citations.content.papercard')
  }
  const location = (source: CitationResolution): string => t('citations.location', {
    pages: source.pages.length ? t('citations.pages', { pages: source.pages.map(page => format.number(page.page)).join(t('citations.pageSeparator')) }) : t('citations.noPages'),
    content: contentLabels[source.content_level] ?? source.content_level
  })
  return { t, statuses, location, format }
}
const CITATION_NUMBER = /^\d+$/
const CITATION_JOINER = '\u2060'
const NUMBERED_CITATION_CLASS = 'inline cursor-pointer align-super text-[0.72em] font-semibold leading-none text-[var(--accent-ink)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)]'
const NAMED_CITATION_CLASS = 'inline cursor-pointer whitespace-normal rounded-sm text-left font-semibold text-[var(--accent-ink)] underline decoration-[var(--vds-border-default)] underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)]'

function citationLabel(node: React.ReactNode): string {
  return React.Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return React.isValidElement<{ children?: React.ReactNode }>(child) ? citationLabel(child.props.children) : ''
  }).join('')
}

function EvidenceContent({ source }: { source: CitationResolution }): React.JSX.Element {
  const { t } = useCitationText()
  const [imageFailed, setImageFailed] = useState(false)
  const previewUrl = citationPreviewUrl(source)
  const previewPage = source.presentation.page
  if (source.presentation.mode === 'structured_text') {
    return <blockquote className="mx-0 mb-0 mt-[var(--vds-space-3)] max-h-52 overflow-auto whitespace-pre-line [overflow-wrap:break-word] border-0 border-t border-solid border-[var(--vds-divider-default)] pt-[var(--vds-space-3)] text-left text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-secondary)]">
      <mark className="rounded-[var(--vds-radius-2)] bg-[var(--vds-brand-bg-light)] px-1 text-inherit">{source.presentation.text}</mark>
    </blockquote>
  }
  if (source.presentation.mode === 'region_image' && previewUrl && previewPage != null && !imageFailed) {
    return <div className="mt-[var(--vds-space-3)] grid gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]">
      <img src={previewUrl} loading="lazy" onError={() => setImageFailed(true)} alt={t('citations.evidenceImageAlt', { page: previewPage })} className="max-h-72 w-full rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] object-contain" />
      <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
        <Badge size="sm" tone="warning">{t('citations.manualCheck')}</Badge>
        {source.presentation.precision === 'page' && <span className="text-xs text-[var(--vds-text-secondary)]">{t('citations.pageOnly')}</span>}
      </div>
    </div>
  }
  return <Alert className="mt-[var(--vds-space-3)]" tone="warning" description={t('citations.displayUnavailable')} />
}

function SourcePreview({ source, onOpenOriginal }: { source: CitationResolution; onOpenOriginal?: () => void }): React.JSX.Element {
  const { t, statuses, location } = useCitationText()
  return <div className="relative pl-6 text-left">
    <img src={iconPdf} alt="" className="absolute left-0 top-0.5 h-4 w-4 object-contain" />
    <div className="min-w-0">
      <p className="m-0 [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] leading-relaxed font-medium text-[var(--vds-text-primary)]">{source.title}</p>
      <p className="my-1 text-xs text-[var(--vds-text-secondary)]">{location(source)}</p>
      <EvidenceContent source={source} />
      {source.state !== 'exact' && <p role="status" className="mb-0 mt-2 text-xs text-[var(--vds-text-secondary)]">{statuses[source.state]}</p>}
      {onOpenOriginal && source.can_open_pdf && <Button size="sm" variant="secondary" className="mt-[var(--vds-space-3)]" onClick={onOpenOriginal}>{t('citations.viewOriginal')}</Button>}
    </div>
  </div>
}
export function CitationLink({ sessionId, answerId, text, range, handle, children, displayNumber, onResolved }: {
  sessionId: string; answerId: string; text: string; range?: CitationLinkRange; handle?: string; children: React.ReactNode; displayNumber?: number; onResolved?: (source: CitationResolution) => void
}): React.JSX.Element {
  const { t, statuses, location } = useCitationText()
  const { act } = useApp()
  const workspace = useWorkspaceController()
  const trigger = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<CitationResolution>()
  const [error, setErrorCode] = useState<'sourceChanged' | 'unverifiable' | 'openFailed' | ''>('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<CitationResolution>()
  const [previewError, setPreviewError] = useState<'loadFailed' | 'unverifiable' | ''>('')
  const errorText = { sourceChanged: t('citations.error.sourceChanged'), unverifiable: t('citations.error.unverifiable'), openFailed: t('citations.error.openFailed') }
  const label = displayNumber === undefined ? citationLabel(children) : String(displayNumber)
  const numbered = CITATION_NUMBER.test(label)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const inspect = async (next: boolean): Promise<void> => {
    setPreviewOpen(next)
    if (!next) return
    setPreviewError('')
    try {
      const revision = await sha256Text(text)
      const source = await resolveCitation(sessionId, answerId, revision, range?.start ?? 0, range?.end ?? 0, handle)
      if (mounted.current) { setPreview(source); onResolved?.(source) }
    } catch (error) {
      if (mounted.current) setPreviewError(isUnverifiableCitationError(error) ? 'unverifiable' : 'loadFailed')
    }
  }
  const close = (): void => {
    setProblem(undefined); setErrorCode('')
    trigger.current?.focus({ preventScroll: true })
  }
  const reveal = async (source: CitationResolution): Promise<void> => {
    const tabId = await workspace.revealCitation(source, source.matches[0])
    if (mounted.current) {
      act.activateTab(tabId, { returnToExpandedAssistantOnClose: true })
    }
  }
  const open = async (): Promise<void> => {
    setPreviewOpen(false)
    setLoading(true); setErrorCode('')
    let source: CitationResolution | undefined
    try {
      const revision = await sha256Text(text)
      source = await resolveCitation(sessionId, answerId, revision, range?.start ?? 0, range?.end ?? 0, handle)
      if (!mounted.current) return
      setPreview(source); onResolved?.(source)
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
  return <>
    <HoverCard open={previewOpen} onOpenChange={value => void inspect(value)}>
      <HoverCardTrigger asChild><Button ref={trigger} unstyled disabled={loading} aria-busy={loading}
        className={numbered ? NUMBERED_CITATION_CLASS : NAMED_CITATION_CLASS}
        data-citation-state={preview?.state} title={preview?.state === 'unavailable' ? t('citations.unavailableTitle') : undefined} aria-label={t('citations.view', { label: numbered ? `[${label}]` : label })} onClick={() => void open()}><span data-citation-label>{numbered ? <><span aria-hidden className="select-none">{CITATION_JOINER}</span>[{label}]</> : children}</span></Button></HoverCardTrigger>
      <HoverCardContent aria-label={t('citations.preview')} className="!w-80 !max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-[var(--vds-radius-4)] border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)]">
        {previewError && preview && <p role="status" className="text-xs text-[var(--vds-text-secondary)]">{t('citations.stalePreview')}</p>}
        {preview ? <SourcePreview source={preview} onOpenOriginal={() => { setPreviewOpen(false); void reveal(preview).catch(() => { setProblem(preview); setErrorCode('openFailed') }) }} /> : <p role="status" className="m-0 text-sm text-[var(--vds-text-secondary)]">{previewError === 'unverifiable' ? t('citations.previewUnverifiable') : previewError ? t('citations.previewFailed') : t('citations.loading')}</p>}
      </HoverCardContent>
    </HoverCard>
    {(problem || error) && <Dialog open onOpenChange={value => { if (!value) close() }}><DialogPortal>
      <DialogContent aria-label={t('citations.state')}>
        <DialogHeader><DialogTitle>{problem?.title ?? t('citations.openTitle')}</DialogTitle></DialogHeader>
        {problem && <>
          <p className="text-sm text-[var(--vds-text-secondary)]">{location(problem)} · {statuses[problem.state]}</p>
          <EvidenceContent source={problem} />
        </>}
        {error && <p role="alert">{errorText[error]}</p>}
        {problem?.can_open_pdf && problem.state === 'source_only' && <Button onClick={() => void reveal(problem).catch(() => setErrorCode('openFailed'))}>{t('citations.openPdf')}</Button>}
        <Button disabled={loading} aria-busy={loading} onClick={() => void open()}>{loading ? t('citations.checking') : t('citations.check')}</Button>
        <Button variant="secondary" onClick={close}>{t('citations.close')}</Button>
      </DialogContent>
    </DialogPortal></Dialog>}
  </>
}

function openWebSource(url: string): void {
  if (window.scholarseed?.openExternal) void window.scholarseed.openExternal(url)
}

export function WebCitationLink({ source, named = false }: {
  source: Extract<AnswerSource, { kind: 'searched' }>
  named?: boolean
}): React.JSX.Element {
  const { t } = useCitationText()
  const label = named ? source.title : String(source.number)
  return <Popover>
    <PopoverTrigger asChild><Button unstyled className={named ? NAMED_CITATION_CLASS : NUMBERED_CITATION_CLASS}
      aria-label={t('citations.view', { label: named ? label : `[${label}]` })}><span data-citation-label>{named ? label : <><span aria-hidden className="select-none">{CITATION_JOINER}</span>[{label}]</>}</span></Button></PopoverTrigger>
    <PopoverContent aria-label={t('citations.webPreview')} className="!w-80 !max-w-[calc(100vw-2rem)] rounded-[var(--vds-radius-4)] border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)]">
      <div className="flex gap-[var(--vds-space-2)] text-left">
        <Icon name="globe" size={16} />
        <div className="min-w-0">
          <p className="m-0 [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv1)] leading-relaxed font-medium text-[var(--vds-text-primary)]">{source.title}</p>
          <p className="my-1 [overflow-wrap:anywhere] text-xs text-[var(--vds-text-secondary)]">{source.url}</p>
          <p className="my-1 text-xs text-[var(--vds-text-secondary)]">{t(source.search_kind === 'paper' ? 'citations.paperSearchSource' : 'citations.webSearchSource')}</p>
          <Button size="sm" variant="secondary" className="mt-[var(--vds-space-2)]" onClick={() => openWebSource(source.url)}>{t('citations.viewOriginal')}</Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
}

export function CitationSources({ sessionId, answerId, text, answerSources }: { sessionId: string; answerId: string; text: string; answerSources?: AnswerSource[] }): React.JSX.Element | null {
  const { t, statuses, location, format } = useCitationText()
  const [result, setResult] = useState<{ count: number; sources: CitationResolution[] }>()
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => { setResult(undefined) }, [sessionId, answerId, text])
  useEffect(() => {
    let current = true
    setError(false)
    if (text.includes('scholarseed-cite:')) void sha256Text(text).then(revision => citationSources(sessionId, answerId, revision)).then(value => { if (current) setResult(value) }).catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [sessionId, answerId, text, refresh])
  if (error && !result && !answerSources?.length) return <p role="status" className="mt-3 text-xs text-[var(--vds-text-secondary)]">{t('citations.listFailed')}</p>
  const projected = answerSources ?? result?.sources.map((source, index) => ({ number: index + 1, kind: 'receipt' as const, handle: source.handle, citation_urls: [] })) ?? []
  if (!projected.length) return null
  const resolved = new Map(result?.sources.map(source => [source.handle, source]))
  return <div className="mt-3" data-answer-source-list><Popover onOpenChange={open => { if (open) setRefresh(value => value + 1) }}><PopoverTrigger asChild><Button size="sm" variant="secondary" className="gap-2 rounded-full"><Icon name="link" size={16} />{t('citations.sourceCount', { count: projected.length, formattedCount: format.number(projected.length) })}</Button></PopoverTrigger><PopoverContent className="max-h-96 w-96 overflow-auto rounded-2xl p-3">
    {error && <p role="status" className="text-xs text-[var(--vds-text-secondary)]">{t('citations.staleList')}</p>}
    <div role="list" tabIndex={0} aria-label={t('citations.sourceCount', { count: projected.length, formattedCount: format.number(projected.length) })} className="rounded-[var(--vds-radius-3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ink)]">
      {projected.map(source => {
        const pdf = source.kind === 'receipt' ? resolved.get(source.handle) : undefined
        return <div key={source.kind === 'searched' ? source.url : source.handle} role="listitem" data-citation-source-entry className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] py-[var(--vds-space-3)] text-sm last:border-0">
          <span className="font-semibold text-[var(--vds-text-secondary)]">[{source.number}]</span>
          <div className="min-w-0">
            {source.kind === 'searched' ? <><WebCitationLink source={source} named /><p className="my-1 [overflow-wrap:anywhere] text-xs text-[var(--vds-text-secondary)]">{source.url}</p><p className="my-1 text-xs text-[var(--vds-text-secondary)]">{t(source.search_kind === 'paper' ? 'citations.paperSearchSource' : 'citations.webSearchSource')}</p></> : <>
              <CitationLink sessionId={sessionId} answerId={answerId} text={text} handle={source.handle} onResolved={updated => setResult(current => current ? { ...current, sources: current.sources.map(item => item.handle === updated.handle ? updated : item) } : { count: 1, sources: [updated] })}>{pdf?.title ?? t('citations.loading')}</CitationLink>
              {pdf && <><p className="my-1 text-xs text-[var(--vds-text-secondary)]">{location(pdf)}</p>{pdf.state !== 'exact' && <p role="status" className="text-xs text-[var(--vds-text-secondary)]">{statuses[pdf.state]}</p>}</>}
            </>}
          </div>
        </div>
      })}
    </div>
  </PopoverContent></Popover></div>
}
