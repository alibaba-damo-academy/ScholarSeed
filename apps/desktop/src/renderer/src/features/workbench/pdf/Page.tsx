import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { type PDFPageProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { TextLayerBuilder } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'

import { Button, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui'
import type { PdfMark } from '../api'
import type { PdfFonts } from './fonts'
import { citationRegions, clipQuads, enclosingRectangle, matchText, nearestRectangle, projectVisibleMarks } from './geometry'
import { externalPdfLinks, PDF_ANNOTATION_INTENT, type ExternalPdfLink } from './links'
import {
  PDF_HIGHLIGHT_OPACITY,
  PDF_MARK_COLORS,
  PDF_SEARCH_HIGHLIGHT_OPACITY,
  PDF_STRIKETHROUGH_THICKNESS,
  PDF_UNDERLINE_OPACITY,
  PDF_UNDERLINE_THICKNESS
} from './records'
import { internalLink, type PdfDestination, type PdfInternalLink } from './navigation'

const NEAR_PAGE_MARGIN = '600px'
const MAX_RENDER_PIXELS = 16_000_000
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

interface PdfLinkTarget {
  matched: boolean
  quad: number[]
}

export type PdfFocusTarget = { kind: 'reading'; page: number; text: string } | { kind: 'search'; page: number; ordinal: number } | { kind: 'annotation'; page: number; id: string } | { kind: 'citation'; page: number; region?: number } | { kind: 'link'; page: number; left: number; top: number }
export type PdfFocus = PdfFocusTarget & { sequence: number }

/** Map PDF.js text spans (including its line breaks) back to DOM ranges. */
function searchQuads(host: HTMLElement, query: string): { quad: number[]; ordinal: number }[] {
  const parts: { node: Text; start: number; end: number }[] = []
  let text = ''
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length
      text += node.textContent ?? ''
      parts.push({ node: node as Text, start, end: text.length })
    } else if ((node as Element).tagName === 'BR') text += '\n'
    node = walker.nextNode()
  }
  return matchText(text, query).flatMap((match, ordinal) => {
    const first = parts.find(part => part.end > match.start)
    const last = parts.find(part => part.end >= match.end)
    if (!first || !last) return []
    const range = document.createRange()
    range.setStart(first.node, Math.max(0, match.start - first.start))
    range.setEnd(last.node, Math.min(last.node.length, match.end - last.start))
    return clipQuads(Array.from(range.getClientRects()), host.getBoundingClientRect()).map(quad => ({ quad, ordinal }))
  })
}

export function PdfPage({ page, fonts, scale, annotations = [], commentMarkIds = [], search = '', focus, citationQuads = [], selectionQuads = [], thumbnail = false, onAnnotationOpen, onInternalLink, renderAnnotation }: {
  page: PDFPageProxy
  fonts: PdfFonts
  scale: number
  annotations?: PdfMark[]
  commentMarkIds?: string[]
  search?: string
  focus?: PdfFocus
  citationQuads?: number[][]
  selectionQuads?: number[][]
  thumbnail?: boolean
  onAnnotationOpen?: (mark: PdfMark) => void
  onInternalLink?: (destination: PdfDestination) => void | Promise<void>
  renderAnnotation?: (mark: PdfMark, close: () => void) => ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement | null>(null)
  const annotationTriggers = useRef(new Map<string, HTMLButtonElement>())
  const [openAnnotation, setOpenAnnotation] = useState<string | null>(null)
  const consumedFocus = useRef<number>()
  const [near, setNear] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matches, setMatches] = useState<{ quad: number[]; ordinal: number }[]>([])
  const [readingMatches, setReadingMatches] = useState<{ quad: number[]; ordinal: number }[]>([])
  const [links, setLinks] = useState<PdfInternalLink[]>([])
  const [externalLinks, setExternalLinks] = useState<ExternalPdfLink[]>([])
  const [linkTarget, setLinkTarget] = useState<PdfLinkTarget | null>(null)
  const viewport = page.getViewport({ scale })
  const visibleAnnotations = useMemo(() => projectVisibleMarks(annotations), [annotations])

  useEffect(() => {
    if (!host.current) return
    const observer = new IntersectionObserver(entries => setNear(entries[0]?.isIntersecting ?? false), { rootMargin: NEAR_PAGE_MARGIN })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const target = canvas.current
    const layer = textHost.current
    setReady(false)
    setError(null)
    if (!near || !target || (!thumbnail && !layer)) return
    let active = true
    const view = page.getViewport({ scale })
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_RENDER_PIXELS / (view.width * view.height)))
    target.width = Math.max(1, Math.floor(view.width * ratio))
    target.height = Math.max(1, Math.floor(view.height * ratio))
    const context = target.getContext('2d')
    if (!context) return
    let render: RenderTask | undefined
    let textLayer: TextLayerBuilder | undefined
    const events = new AbortController()
    void fonts.prepare(page).then(async () => {
      if (!active) return
      render = page.render({ canvas: target, canvasContext: context, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] })
      layer?.replaceChildren()
      if (!thumbnail && layer) {
        textLayer = new TextLayerBuilder({ pdfPage: fonts.textPage(page), abortSignal: events.signal })
        if (page.pageNumber === 1) textLayer.div.dataset.ob = 'pdf-first-text'
        text.current = textLayer.div
        layer.append(textLayer.div)
      }
      // @ts-expect-error PDF.js 6.3.289 types require images; its implementation accepts omission.
      await Promise.all([render.promise, textLayer?.render({ viewport: view })])
      if (active) setReady(true)
    }).catch((reason: unknown) => {
      if (active && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })
    return () => {
      active = false
      render?.cancel()
      events.abort()
      textLayer?.cancel()
      text.current = null
      // Release offscreen canvases, keeping page geometry for scrolling/navigation.
      target.width = 0
      target.height = 0
    }
  }, [near, page, fonts, scale, thumbnail])

  useEffect(() => {
    if (thumbnail || !near) return
    let active = true
    const annotationViewport = page.getViewport({ scale: 1 })
    void page.getAnnotations({ intent: 'display' }).then(items => {
      if (active) setLinks(items.flatMap(item => {
        const link = internalLink(item, annotationViewport)
        return link ? [link] : []
      }))
    }).catch(() => {
      if (active) setLinks([])
    })
    return () => { active = false }
  }, [near, page, thumbnail])

  useEffect(() => {
    setExternalLinks([])
    if (!near || thumbnail) return
    let active = true
    const view = page.getViewport({ scale })
    void page.getAnnotations({ intent: PDF_ANNOTATION_INTENT }).then(annotations => {
      if (active) setExternalLinks(externalPdfLinks(annotations, view))
    }).catch((reason: unknown) => {
      console.error(`[pdf-links] ${reason instanceof Error ? reason.message : String(reason)}`)
    })
    return () => { active = false }
  }, [near, page, scale, thumbnail])

  useEffect(() => {
    setMatches(ready && text.current && search.trim() ? searchQuads(text.current, search) : [])
  }, [ready, search, scale])
  useEffect(() => {
    setReadingMatches(ready && text.current && focus?.kind === 'reading' ? searchQuads(text.current, focus.text) : [])
  }, [ready, focus, scale])

  const searchMarks = matches.map(({ quad, ordinal }, index) => ({ key: `search-${index}`, quad, color: '#ff9d33', opacity: PDF_SEARCH_HIGHLIGHT_OPACITY, currentSearch: focus?.kind === 'search' && ordinal === focus.ordinal }))

  useEffect(() => {
    if (!focus || (!ready && focus.kind !== 'citation' && focus.kind !== 'link') || consumedFocus.current === focus.sequence) return
    if (focus.kind === 'link') {
      const pageHost = host.current
      const textLayer = text.current
      if (!pageHost) return
      if (!ready || !textLayer) {
        pageHost.scrollIntoView({ block: 'center', inline: 'nearest' })
        return
      }
      const pageBounds = pageHost.getBoundingClientRect()
      const candidates = Array.from(textLayer.querySelectorAll<HTMLElement>('span')).flatMap(element => {
        if (!element.textContent?.trim()) return []
        const rectangle = element.getBoundingClientRect()
        return rectangle.width > 0 && rectangle.height > 0 ? [{ element, rectangle }] : []
      })
      const rectangle = nearestRectangle(
        candidates.map(candidate => candidate.rectangle),
        { x: pageBounds.left + focus.left * pageBounds.width, y: pageBounds.top + focus.top * pageBounds.height }
      )
      const candidate = candidates.find(item => item.rectangle === rectangle)
      const quad = rectangle ? clipQuads([rectangle], pageBounds)[0] : undefined
      if (candidate && quad) {
        setLinkTarget({ matched: true, quad })
        candidate.element.scrollIntoView({ block: 'center', inline: 'nearest' })
      } else {
        setLinkTarget({ matched: false, quad: [focus.left, focus.top, focus.left, focus.top] })
        pageHost.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
      consumedFocus.current = focus.sequence
      return
    }
    setLinkTarget(null)
    const selector = focus.kind === 'reading' ? '[data-reading-highlight]' : focus.kind === 'citation' ? '[data-citation-highlight]' : focus.kind === 'search' ? '[data-current-search=true]' : `[data-annotation-id="${CSS.escape(focus.id)}"]`
    const target = host.current?.querySelector<HTMLElement>(selector)
    if (!target) return
    if (focus.kind === 'citation') {
      const nodes = [...(host.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
      const regions = citationRegions(citationQuads)
      const start = regions.slice(0, focus.region ?? 0).reduce((count, region) => count + region.length, 0)
      const selected = focus.region === undefined ? nodes : nodes.slice(start, start + (regions[focus.region]?.length ?? 0))
      const bounds = enclosingRectangle(selected.map(node => node.getBoundingClientRect()))
      const viewport = host.current?.closest<HTMLElement>('.vds-pdf-pages')
      if (bounds && viewport) {
        const visible = viewport.getBoundingClientRect()
        viewport.scrollBy({ behavior: window.matchMedia(REDUCED_MOTION_QUERY).matches ? 'instant' : 'smooth', top: (bounds.top + bounds.bottom - visible.top - visible.bottom) / 2,
          left: (bounds.left + bounds.right - visible.left - visible.right) / 2 })
      }
    } else target.scrollIntoView({ block: 'center', inline: 'nearest' })
    consumedFocus.current = focus.sequence
  }, [ready, focus, matches, citationQuads, readingMatches])

  return (
    <div ref={host} className={thumbnail ? 'vds-pdf-thumbnail-page' : 'vds-pdf-page'}
      data-testid={thumbnail ? undefined : `pdf-page-${page.pageNumber}`} data-page={page.pageNumber}
      data-rendered={ready} style={{ width: viewport.width, height: viewport.height, '--total-scale-factor': scale * page.userUnit } as React.CSSProperties}>
      {near && <canvas ref={canvas} style={{ width: viewport.width, height: viewport.height }} />}
      {!thumbnail && <div ref={textHost} onClick={event => {
        if (window.getSelection()?.toString()) return
        const bounds = host.current?.getBoundingClientRect()
        if (!bounds) return
        const x = (event.clientX - bounds.left) / bounds.width
        const y = (event.clientY - bounds.top) / bounds.height
        const mark = visibleAnnotations.find(annotation => annotation.quads.some(([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom))?.mark
        // Activate the existing trigger so pointer hit testing also supplies
        // the popover anchor and follows the keyboard activation path.
        if (mark) annotationTriggers.current.get(mark.id)?.click()
      }} />}
      {!ready && <span className="vds-pdf-page-placeholder">{error !== null ? t('pageRenderFailed', { detail: error }) : t('page', { page: page.pageNumber })}</span>}
      {!thumbnail && <div className="vds-pdf-annotation-layer pointer-events-none absolute inset-0 z-[var(--vds-z-local-control)] overflow-hidden">
        {focus?.kind === 'link' && linkTarget ? <span
          data-internal-link-target
          data-matched-text={linkTarget.matched}
          className={`${linkTarget.matched ? 'absolute' : 'absolute size-[var(--vds-space-3)] -translate-x-1/2 -translate-y-1/2'} rounded-[var(--vds-radius-2)] bg-[var(--vds-pdf-citation-highlight)] opacity-[var(--pdf-highlight-opacity)] outline outline-2 outline-[var(--vds-notice-border-default)]`}
          style={{
            left: `${linkTarget.quad[0] * 100}%`,
            top: `${linkTarget.quad[1] * 100}%`,
            width: linkTarget.matched ? `${(linkTarget.quad[2] - linkTarget.quad[0]) * 100}%` : undefined,
            height: linkTarget.matched ? `${(linkTarget.quad[3] - linkTarget.quad[1]) * 100}%` : undefined,
            '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY
          } as React.CSSProperties}
        /> : null}
        {links.map(link => <Button
          unstyled
          key={link.id}
          aria-label={t('internalLink', { label: link.label || t('internalLinkFallback') })}
          data-testid={`pdf-internal-link-${link.id}`}
          className="pointer-events-auto absolute cursor-pointer rounded-[var(--vds-radius-1)] bg-transparent hover:outline hover:outline-1 hover:outline-[var(--vds-brand-border-default)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vds-brand-border-default)]"
          onClick={() => void onInternalLink?.(link.destination)}
          style={{ left: `${link.rect[0] * 100}%`, top: `${link.rect[1] * 100}%`, width: `${(link.rect[2] - link.rect[0]) * 100}%`, height: `${(link.rect[3] - link.rect[1]) * 100}%` }}
        />)}
        {externalLinks.map((link, index) => <Button
          unstyled
          key={`${link.url}-${index}`}
          aria-label={t('openExternalLink', { url: link.url })}
          className="pointer-events-auto absolute cursor-pointer border-0 bg-transparent p-0 focus-visible:shadow-[var(--vds-focus-brand)]"
          data-testid={`pdf-external-link-${page.pageNumber}-${index}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void window.scholarseed.openExternal(link.url)
          }}
          style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
        />)}
        {selectionQuads.map((quad, index) => <span key={`selection-${index}`} data-pdf-selection-highlight className="bg-[var(--vds-notice-bg-default)] opacity-[var(--pdf-highlight-opacity)]" style={{
          left: `${quad[0] * 100}%`, top: `${quad[1] * 100}%`, width: `${(quad[2] - quad[0]) * 100}%`, height: `${(quad[3] - quad[1]) * 100}%`, '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY
        } as React.CSSProperties} />)}
        {readingMatches.map(({ quad }, index) => <span key={`reading-${index}`} data-reading-highlight className="bg-[var(--vds-brand-bg-disabled)] opacity-[var(--pdf-highlight-opacity)]" style={{ left: `${quad[0] * 100}%`, top: `${quad[1] * 100}%`, width: `${(quad[2] - quad[0]) * 100}%`, height: `${(quad[3] - quad[1]) * 100}%`, '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY } as React.CSSProperties} />)}
        {citationQuads.map((quad, index) => <span key={`citation-${index}`} data-citation-highlight className="bg-[var(--vds-pdf-citation-highlight)] opacity-[var(--pdf-highlight-opacity)]" style={{
          left: `${quad[0] * 100}%`, top: `${quad[1] * 100}%`, width: `${(quad[2] - quad[0]) * 100}%`, height: `${(quad[3] - quad[1]) * 100}%`, '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY
        } as React.CSSProperties} />)}
        {searchMarks.map(mark => <span key={mark.key} data-current-search={mark.currentSearch} className={`absolute mix-blend-multiply${mark.currentSearch ? ' outline-2 outline-[var(--vds-warning-text-primary)]' : ''}`} style={{
          left: `${mark.quad[0] * 100}%`, top: `${mark.quad[1] * 100}%`,
          width: `${(mark.quad[2] - mark.quad[0]) * 100}%`, height: `${(mark.quad[3] - mark.quad[1]) * 100}%`,
          opacity: mark.opacity, background: mark.color
        }} />)}
        {visibleAnnotations.flatMap(({ mark: annotation, quads }) => quads.map((quad, index) => {
          const color = PDF_MARK_COLORS[annotation.color]
          const hasComment = commentMarkIds.includes(annotation.id) && index === quads.length - 1
          const markVisual = annotation.style === 'highlight'
            ? 'bg-[var(--pdf-mark-color)] opacity-[var(--pdf-mark-opacity)]'
            : annotation.style === 'underline'
              ? 'border-b-[length:var(--pdf-mark-thickness)] border-b-[var(--pdf-mark-color)] opacity-[var(--pdf-mark-opacity)]'
              : ''
          return <Popover key={`${annotation.id}-${index}`} open={openAnnotation === annotation.id && index === 0} onOpenChange={(open) => { setOpenAnnotation(open ? annotation.id : null); if (open) onAnnotationOpen?.(annotation) }}>
            <PopoverTrigger asChild>
              <Button
                unstyled
                ref={index === 0 ? button => {
                  if (button) annotationTriggers.current.set(annotation.id, button)
                  else annotationTriggers.current.delete(annotation.id)
                } : undefined}
                aria-label={t('pdfAnnotation.location', { page: annotation.page, text: annotation.text })}
                data-annotation-id={annotation.id}
                data-testid={`pdf-mark-${annotation.id}`}
                className="pointer-events-none absolute cursor-pointer mix-blend-multiply"
                onClick={index === 0 ? undefined : event => {
                  event.preventDefault()
                  annotationTriggers.current.get(annotation.id)?.click()
                }}
                onMouseUp={(event) => event.stopPropagation()}
                style={{
                  left: `${quad[0] * 100}%`, top: `${quad[1] * 100}%`,
                  width: `${(quad[2] - quad[0]) * 100}%`, height: `${(quad[3] - quad[1]) * 100}%`,
                  '--pdf-mark-color': color,
                  '--pdf-mark-opacity': annotation.style === 'highlight' ? PDF_HIGHLIGHT_OPACITY : PDF_UNDERLINE_OPACITY,
                  '--pdf-mark-thickness': `${PDF_UNDERLINE_THICKNESS * scale}px`
                } as React.CSSProperties}
              >
                <span aria-hidden className={`absolute inset-0 ${markVisual}`} />
                {annotation.style === 'strikethrough' ? <span aria-hidden className="absolute left-0 top-1/2 w-full border-t-[length:var(--pdf-strikethrough-thickness)] border-t-[var(--pdf-mark-color)] opacity-[var(--pdf-mark-opacity)]" style={{ '--pdf-strikethrough-thickness': `${PDF_STRIKETHROUGH_THICKNESS * scale}px` } as React.CSSProperties} /> : null}
                {hasComment ? <span aria-hidden className="pointer-events-auto absolute -right-3 -top-2.5 grid size-4 place-items-center rounded-full bg-[var(--vds-brand-bg-default)] text-xs font-bold leading-none text-[var(--vds-text-on-brand)] opacity-100">“</span> : null}
              </Button>
            </PopoverTrigger>
            {renderAnnotation ? <PopoverContent className="z-[var(--vds-z-inline-flyout)] gap-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] p-0">{renderAnnotation(annotation, () => setOpenAnnotation(null))}</PopoverContent> : null}
          </Popover>
        }))}
      </div>}
    </div>
  )
}
