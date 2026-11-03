import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { OPS, type PDFPageProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { TextLayerBuilder } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'

import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '../../../components/ui'
import { Icon } from '../../../icons'
import type { PdfMark } from '../api'
import type { PdfVisualRegion } from './analysis'
import type { PdfFonts } from './fonts'
import {
  citationRegions,
  clipQuads,
  enclosingRectangle,
  matchReadingText,
  matchText,
  nearestRectangle,
  projectVisibleMarks,
  type Size,
} from './geometry'
import { externalPdfLinks, PDF_ANNOTATION_INTENT, type ExternalPdfLink } from './links'
import {
  PDF_HIGHLIGHT_OPACITY,
  PDF_HIGHLIGHT_VISUAL_CLASS,
  PDF_MARK_COLORS,
  PDF_SEARCH_HIGHLIGHT_OPACITY,
  PDF_STRIKETHROUGH_THICKNESS,
  PDF_UNDERLINE_OPACITY,
  PDF_UNDERLINE_THICKNESS,
  pdfMarkVisualClass,
} from './records'
import { internalLink, type PdfDestination, type PdfInternalLink } from './navigation'
import { latestIntersection } from './utils'
import { groupPdfRegions, pdfRegionText, paintedGraphics } from './regions'

const NEAR_PAGE_MARGIN = '600px'
const MAX_RENDER_PIXELS = 16_000_000
const PDF_ZOOM_RENDER_DELAY_MS = 400
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const PDF_ANNOTATION_CLICK_MAX_MOVEMENT_PX = 6

function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return
  canvas.width = 0
  canvas.height = 0
}

interface PdfLinkTarget {
  matched: boolean
  quad: number[]
}

export type PdfFocusTarget =
  | { kind: 'reading'; page: number; text: string }
  | { kind: 'search'; page: number; ordinal: number }
  | { kind: 'annotation'; page: number; id: string }
  | { kind: 'citation'; page: number; region?: number }
  | { kind: 'link'; page: number; left: number; top: number }
export type PdfFocus = PdfFocusTarget & { sequence: number }

export interface PdfPageProps {
  page: PDFPageProxy
  fonts: PdfFonts
  scale: number
  annotations?: PdfMark[]
  commentMarkIds?: string[]
  search?: string
  focus?: PdfFocus
  citationQuads?: number[][]
  selectionQuads?: number[][]
  visualRegionImageInputAvailable?: boolean
  copyingVisualRegionId?: string
  thumbnail?: boolean
  keepRendered?: boolean
  onAnnotationOpen?: (mark: PdfMark) => void
  onInternalLink?: (destination: PdfDestination) => void | Promise<void>
  onVisualRegionExplain?: (region: PdfVisualRegion) => void
  onVisualRegionCopy?: (region: PdfVisualRegion) => void
  renderAnnotation?: (mark: PdfMark, close: () => void) => ReactNode
}

/** Map PDF.js text spans (including its line breaks) back to DOM ranges. */
function searchQuads(
  host: HTMLElement,
  query: string,
  matcher = matchText
): { quad: number[]; ordinal: number }[] {
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
  return matcher(text, query).flatMap((match, ordinal) => {
    const first = parts.find((part) => part.end > match.start)
    const last = parts.find((part) => part.end >= match.end)
    if (!first || !last) return []
    const range = document.createRange()
    range.setStart(first.node, Math.max(0, match.start - first.start))
    range.setEnd(last.node, Math.min(last.node.length, match.end - last.start))
    return clipQuads(Array.from(range.getClientRects()), host.getBoundingClientRect()).map(
      (quad) => ({ quad, ordinal })
    )
  })
}

export function PdfPage({
  page,
  fonts,
  scale,
  annotations = [],
  commentMarkIds = [],
  search = '',
  focus,
  citationQuads = [],
  selectionQuads = [],
  visualRegionImageInputAvailable = true,
  copyingVisualRegionId,
  thumbnail = false,
  keepRendered = false,
  onAnnotationOpen,
  onInternalLink,
  onVisualRegionExplain,
  onVisualRegionCopy,
  renderAnnotation,
}: PdfPageProps): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const stagingCanvas = useRef<HTMLCanvasElement | null>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement | null>(null)
  const annotationTriggers = useRef(new Map<string, HTMLButtonElement>())
  const annotationPointerDown = useRef<{ markId: string | null; x: number; y: number } | null>(null)
  const [openAnnotation, setOpenAnnotation] = useState<string | null>(null)
  const consumedFocus = useRef<number>()
  const [near, setNear] = useState(false)
  const [canvasReady, setCanvasReady] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matches, setMatches] = useState<{ quad: number[]; ordinal: number }[]>([])
  const [renderScale, setRenderScale] = useState(scale)
  const renderSequence = useRef(0)
  const renderSettled = useRef<Promise<unknown>>(Promise.resolve())
  const [readingMatches, setReadingMatches] = useState<{ quad: number[]; ordinal: number }[]>([])
  const [links, setLinks] = useState<PdfInternalLink[]>([])
  const [externalLinks, setExternalLinks] = useState<ExternalPdfLink[]>([])
  const [linkTarget, setLinkTarget] = useState<PdfLinkTarget | null>(null)
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null)
  const [visualRegions, setVisualRegions] = useState<PdfVisualRegion[]>([])
  const [focusedRegion, setFocusedRegion] = useState<string | null>(null)
  const viewport = page.getViewport({ scale })
  const renderable = near || keepRendered || Boolean(focus)
  const visibleAnnotations = useMemo(() => projectVisibleMarks(annotations), [annotations])
  const annotationAt = (clientX: number, clientY: number): PdfMark | undefined => {
    const bounds = host.current?.getBoundingClientRect()
    if (!bounds) return undefined
    const x = (clientX - bounds.left) / bounds.width
    const y = (clientY - bounds.top) / bounds.height
    return visibleAnnotations.find((annotation) =>
      annotation.quads.some(
        ([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom
      )
    )?.mark
  }

  useEffect(() => {
    if (!host.current) return
    const observer = new IntersectionObserver(
      (entries) => setNear(latestIntersection(entries)?.isIntersecting ?? false),
      { rootMargin: NEAR_PAGE_MARGIN }
    )
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (scale === renderScale) return
    const timer = window.setTimeout(() => setRenderScale(scale), PDF_ZOOM_RENDER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [renderScale, scale])

  useEffect(
    () => () => {
      const settled = renderSettled.current
      const target = canvas.current
      const staging = stagingCanvas.current
      void settled
        .catch(() => undefined)
        .then(() => {
          releaseCanvas(target)
          releaseCanvas(staging)
          page.cleanup()
        })
    },
    [page]
  )

  useEffect(() => {
    const sequence = ++renderSequence.current
    const target = canvas.current
    const layer = textHost.current
    setReady(false)
    setVisualRegions([])
    setError(null)
    if (!renderable || !target || (!thumbnail && !layer)) {
      setCanvasReady(false)
      const settled = renderSettled.current
      void settled
        .catch(() => undefined)
        .then(() => {
          releaseCanvas(target)
          if (renderSequence.current !== sequence) return
          releaseCanvas(stagingCanvas.current)
          if (canvas.current === target) canvas.current = null
          page.cleanup()
        })
      return
    }
    let active = true
    let render: RenderTask | undefined
    let textLayer: TextLayerBuilder | undefined
    const events = new AbortController()
    const previousRender = renderSettled.current
    const settled = previousRender
      .catch(() => undefined)
      .then(async () => {
        if (!active) return
        const staging = stagingCanvas.current ?? document.createElement('canvas')
        stagingCanvas.current = staging
        const view = page.getViewport({ scale: renderScale })
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_RENDER_PIXELS / (view.width * view.height))
        )
        staging.width = Math.max(1, Math.floor(view.width * ratio))
        staging.height = Math.max(1, Math.floor(view.height * ratio))
        const context = staging.getContext('2d')
        if (!context) return
        render = page.render({
          canvas: staging,
          canvasContext: context,
          viewport: view,
          transform: [ratio, 0, 0, ratio, 0, 0],
          recordImages: !thumbnail,
        })
        await render.promise
        if (!active) return
        target.width = staging.width
        target.height = staging.height
        const targetContext = target.getContext('2d')
        if (!targetContext) return
        targetContext.drawImage(staging, 0, 0)
        releaseCanvas(staging)
        setCanvasReady(true)
        if (thumbnail || !layer) {
          setReady(true)
          return
        }
        const content = await fonts.prepare(page)
        if (!active) return
        const operations = await page.getOperatorList()
        if (!active) return
        setVisualRegions(
          groupPdfRegions(
            page.pageNumber,
            view.width,
            view.height,
            paintedGraphics(operations, page.imageCoordinates, view, OPS),
            pdfRegionText(content, view),
            view.scale * page.userUnit
          )
        )
        const language = content.lang || document.documentElement.lang || navigator.language
        layer?.replaceChildren()
        textLayer = new TextLayerBuilder({
          pdfPage: fonts.textPage(page, language),
          abortSignal: events.signal,
          onAppend: (div: HTMLDivElement) => {
            if (!active || events.signal.aborted || renderSequence.current !== sequence) return
            layer.replaceChildren(div)
            text.current = div
          },
        })
        textLayer.div.lang = language
        if (page.pageNumber === 1) textLayer.div.dataset.ob = 'pdf-first-text'
        // @ts-expect-error PDF.js 6.3.289 types require images; its implementation accepts omission.
        await textLayer.render({ viewport: view })
        if (active && renderSequence.current === sequence && text.current === textLayer.div)
          setReady(true)
      })
    renderSettled.current = settled
    void settled.catch((reason: unknown) => {
      if (active && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })
    return () => {
      active = false
      render?.cancel()
      events.abort()
      textLayer?.cancel()
      if (text.current === textLayer?.div) text.current = null
    }
  }, [renderable, page, fonts, renderScale, thumbnail])

  useEffect(() => {
    if (thumbnail || !near) return
    let active = true
    const annotationViewport = page.getViewport({ scale: 1 })
    void page
      .getAnnotations({ intent: 'display' })
      .then((items) => {
        if (active)
          setLinks(
            items.flatMap((item) => {
              const link = internalLink(item, annotationViewport)
              return link ? [link] : []
            })
          )
      })
      .catch(() => {
        if (active) setLinks([])
      })
    return () => {
      active = false
    }
  }, [near, page, thumbnail])

  useEffect(() => {
    setExternalLinks([])
    if (!near || thumbnail) return
    let active = true
    const view = page.getViewport({ scale })
    void page
      .getAnnotations({ intent: PDF_ANNOTATION_INTENT })
      .then((annotations) => {
        if (active) setExternalLinks(externalPdfLinks(annotations, view))
      })
      .catch((reason: unknown) => {
        console.error(`[pdf-links] ${reason instanceof Error ? reason.message : String(reason)}`)
      })
    return () => {
      active = false
    }
  }, [near, page, scale, thumbnail])

  useEffect(() => {
    setMatches(ready && text.current && search.trim() ? searchQuads(text.current, search) : [])
  }, [ready, search, scale])
  useEffect(() => {
    setReadingMatches(
      ready && text.current && focus?.kind === 'reading'
        ? searchQuads(text.current, focus.text, matchReadingText)
        : []
    )
  }, [ready, focus, scale])

  const searchMarks = matches.map(({ quad, ordinal }, index) => ({
    key: `search-${index}`,
    quad,
    color: '#ff9d33',
    opacity: PDF_SEARCH_HIGHLIGHT_OPACITY,
    currentSearch: focus?.kind === 'search' && ordinal === focus.ordinal,
  }))

  useEffect(() => {
    if (
      !focus ||
      (!ready && focus.kind !== 'citation' && focus.kind !== 'link') ||
      consumedFocus.current === focus.sequence
    )
      return
    if (focus.kind === 'link') {
      const pageHost = host.current
      const textLayer = text.current
      if (!pageHost) return
      if (!ready || !textLayer) {
        pageHost.scrollIntoView({ block: 'center', inline: 'nearest' })
        return
      }
      const pageBounds = pageHost.getBoundingClientRect()
      const candidates = Array.from(textLayer.querySelectorAll<HTMLElement>('span')).flatMap(
        (element) => {
          if (!element.textContent?.trim()) return []
          const rectangle = element.getBoundingClientRect()
          return rectangle.width > 0 && rectangle.height > 0 ? [{ element, rectangle }] : []
        }
      )
      const rectangle = nearestRectangle(
        candidates.map((candidate) => candidate.rectangle),
        {
          x: pageBounds.left + focus.left * pageBounds.width,
          y: pageBounds.top + focus.top * pageBounds.height,
        }
      )
      const candidate = candidates.find((item) => item.rectangle === rectangle)
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
    if (focus.kind === 'citation' && !citationQuads.length) {
      const pageHost = host.current
      if (!pageHost) return
      pageHost.scrollIntoView({ block: 'start', inline: 'nearest' })
      consumedFocus.current = focus.sequence
      return
    }
    const selector =
      focus.kind === 'reading'
        ? '[data-reading-highlight]'
        : focus.kind === 'citation'
          ? '[data-citation-highlight]'
          : focus.kind === 'search'
            ? '[data-current-search=true]'
            : `[data-annotation-id="${CSS.escape(focus.id)}"]`
    const target = host.current?.querySelector<HTMLElement>(selector)
    if (!target) return
    if (focus.kind === 'citation') {
      const nodes = [...(host.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
      const regions = citationRegions(citationQuads)
      const start = regions
        .slice(0, focus.region ?? 0)
        .reduce((count, region) => count + region.length, 0)
      const selected =
        focus.region === undefined
          ? nodes
          : nodes.slice(start, start + (regions[focus.region]?.length ?? 0))
      const bounds = enclosingRectangle(selected.map((node) => node.getBoundingClientRect()))
      const viewport = host.current?.closest<HTMLElement>('.vds-pdf-pages')
      if (bounds && viewport) {
        const visible = viewport.getBoundingClientRect()
        viewport.scrollBy({
          behavior: window.matchMedia(REDUCED_MOTION_QUERY).matches ? 'instant' : 'smooth',
          top: (bounds.top + bounds.bottom - visible.top - visible.bottom) / 2,
          left: (bounds.left + bounds.right - visible.left - visible.right) / 2,
        })
      }
    } else target.scrollIntoView({ block: 'center', inline: 'nearest' })
    consumedFocus.current = focus.sequence
  }, [ready, focus, matches, citationQuads, readingMatches])

  return (
    <div
      ref={host}
      className={
        thumbnail
          ? 'vds-pdf-thumbnail-page relative overflow-hidden bg-white'
          : 'vds-pdf-page relative mb-[var(--vds-space-4)] flex-shrink-0 bg-white text-[var(--vds-static-black)] leading-none shadow-[var(--vds-shadow-2-center)]'
      }
      data-testid={thumbnail ? undefined : `pdf-page-${page.pageNumber}`}
      data-page={page.pageNumber}
      data-canvas-rendered={canvasReady}
      data-visual-region-count={visualRegions.length}
      data-text-rendered={ready}
      data-rendered={ready}
      onPointerMove={
        thumbnail
          ? undefined
          : (event) => {
              const bounds = host.current?.getBoundingClientRect()
              if (!bounds || (event.target as HTMLElement).closest('[data-pdf-visual-toolbar]'))
                return
              const x = (event.clientX - bounds.left) / bounds.width
              const y = (event.clientY - bounds.top) / bounds.height
              const selected = visualRegions.find(
                (region) =>
                  region.quad[0] <= x &&
                  x <= region.quad[2] &&
                  region.quad[1] <= y &&
                  y <= region.quad[3]
              )
              setHoveredRegion(selected?.region_id ?? null)
            }
      }
      onPointerLeave={thumbnail ? undefined : () => setHoveredRegion(null)}
      style={
        {
          width: viewport.width,
          height: viewport.height,
          '--total-scale-factor': scale * page.userUnit,
        } as React.CSSProperties
      }
    >
      {renderable && (
        <canvas
          className="block"
          ref={(node) => {
            if (node) canvas.current = node
          }}
          style={{ width: viewport.width, height: viewport.height }}
        />
      )}
      {!thumbnail && (
        <div
          ref={textHost}
          onPointerDown={(event) => {
            annotationPointerDown.current = {
              markId: annotationAt(event.clientX, event.clientY)?.id ?? null,
              x: event.clientX,
              y: event.clientY,
            }
          }}
          onPointerCancel={() => {
            annotationPointerDown.current = null
          }}
          onClick={(event) => {
            const pointerDown = annotationPointerDown.current
            annotationPointerDown.current = null
            if (window.getSelection()?.toString()) return
            const mark = annotationAt(event.clientX, event.clientY)
            if (
              mark &&
              pointerDown?.markId === mark.id &&
              Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) <=
                PDF_ANNOTATION_CLICK_MAX_MOVEMENT_PX
            ) {
              annotationTriggers.current.get(mark.id)?.click()
            }
          }}
        />
      )}
      {!canvasReady && (
        <span className="vds-pdf-page-placeholder pointer-events-none absolute inset-0 grid place-items-center text-[length:var(--vds-font-body-lv1)]">
          {error !== null
            ? t('pageRenderFailed', { detail: error })
            : t('page', { page: page.pageNumber })}
        </span>
      )}
      {!thumbnail && (
        <div className="pointer-events-none absolute inset-0 z-[var(--vds-z-local-control)] overflow-visible">
          {visualRegions.map((region) => {
            const copying = region.kind === 'formula' && copyingVisualRegionId === region.region_id
            const formulaCopyUnavailable =
              region.kind === 'formula' && !visualRegionImageInputAvailable
            const visible =
              hoveredRegion === region.region_id || focusedRegion === region.region_id || copying
            if (!visible) return null
            const explainButton = (
              <IconButton
                size="xs"
                variant="secondary"
                disabled={!visualRegionImageInputAvailable}
                label={t('visualRegions.explain')}
                icon={<Icon name="sparkle" size={12} />}
                onClick={() => onVisualRegionExplain?.(region)}
              />
            )
            const copyButton = (
              <IconButton
                size="xs"
                variant="secondary"
                disabled={region.kind === 'formula' && !visualRegionImageInputAvailable}
                label={t(
                  region.kind === 'formula'
                    ? 'visualRegions.copyFormula'
                    : 'visualRegions.copyImage'
                )}
                loading={copying}
                icon={<Icon name="copy" size={12} />}
                onClick={() => onVisualRegionCopy?.(region)}
              />
            )
            return (
              <div
                key={region.region_id}
                data-pdf-visual-region={region.kind}
                className="absolute border border-dashed border-[var(--vds-border-strong)]"
                style={{
                  left: `${region.quad[0] * 100}%`,
                  top: `${region.quad[1] * 100}%`,
                  width: `${(region.quad[2] - region.quad[0]) * 100}%`,
                  height: `${(region.quad[3] - region.quad[1]) * 100}%`,
                }}
              >
                <div
                  data-pdf-visual-toolbar
                  className="pointer-events-auto absolute bottom-0 right-0 flex translate-y-full gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-1)] shadow-[var(--vds-shadow-raised)]"
                  onFocusCapture={() => setFocusedRegion(region.region_id)}
                  onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setFocusedRegion(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setFocusedRegion(null)
                      setHoveredRegion(null)
                      ;(event.currentTarget.querySelector(':focus') as HTMLElement | null)?.blur()
                    }
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {visualRegionImageInputAvailable ? (
                    explainButton
                  ) : (
                    <Tooltip portalled content={t('reading.figureUnavailable')} side="bottom">
                      <span className="inline-flex">{explainButton}</span>
                    </Tooltip>
                  )}
                  {formulaCopyUnavailable ? (
                    <Tooltip portalled content={t('reading.figureUnavailable')} side="bottom">
                      <span className="inline-flex">{copyButton}</span>
                    </Tooltip>
                  ) : (
                    copyButton
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {!thumbnail && (
        <div
          data-pdf-highlight-layer
          className="pointer-events-none absolute inset-0 z-[var(--vds-z-local-control)] overflow-hidden mix-blend-darken"
        >
          {focus?.kind === 'link' && linkTarget ? (
            <span
              data-internal-link-target
              data-matched-text={linkTarget.matched}
              className={`${linkTarget.matched ? 'absolute' : 'absolute size-[var(--vds-space-3)] -translate-x-1/2 -translate-y-1/2'} rounded-[var(--vds-radius-2)] bg-[var(--vds-pdf-citation-highlight)] opacity-[var(--pdf-highlight-opacity)] outline outline-2 outline-[var(--vds-notice-border-default)]`}
              style={
                {
                  left: `${linkTarget.quad[0] * 100}%`,
                  top: `${linkTarget.quad[1] * 100}%`,
                  width: linkTarget.matched
                    ? `${(linkTarget.quad[2] - linkTarget.quad[0]) * 100}%`
                    : undefined,
                  height: linkTarget.matched
                    ? `${(linkTarget.quad[3] - linkTarget.quad[1]) * 100}%`
                    : undefined,
                  '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY,
                } as React.CSSProperties
              }
            />
          ) : null}
          {selectionQuads.map((quad, index) => (
            <span
              key={`selection-${index}`}
              data-pdf-selection-highlight
              className="absolute bg-[var(--vds-notice-bg-default)] opacity-[var(--pdf-highlight-opacity)]"
              style={
                {
                  left: `${quad[0] * 100}%`,
                  top: `${quad[1] * 100}%`,
                  width: `${(quad[2] - quad[0]) * 100}%`,
                  height: `${(quad[3] - quad[1]) * 100}%`,
                  '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY,
                } as React.CSSProperties
              }
            />
          ))}
          {readingMatches.map(({ quad }, index) => (
            <span
              key={`reading-${index}`}
              data-reading-highlight
              className="absolute bg-[var(--vds-brand-bg-disabled)] opacity-[var(--pdf-highlight-opacity)]"
              style={
                {
                  left: `${quad[0] * 100}%`,
                  top: `${quad[1] * 100}%`,
                  width: `${(quad[2] - quad[0]) * 100}%`,
                  height: `${(quad[3] - quad[1]) * 100}%`,
                  '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY,
                } as React.CSSProperties
              }
            />
          ))}
          {citationQuads.map((quad, index) => (
            <span
              key={`citation-${index}`}
              data-citation-highlight
              className="absolute bg-[var(--vds-pdf-citation-highlight)] opacity-[var(--pdf-highlight-opacity)]"
              style={
                {
                  left: `${quad[0] * 100}%`,
                  top: `${quad[1] * 100}%`,
                  width: `${(quad[2] - quad[0]) * 100}%`,
                  height: `${(quad[3] - quad[1]) * 100}%`,
                  '--pdf-highlight-opacity': PDF_HIGHLIGHT_OPACITY,
                } as React.CSSProperties
              }
            />
          ))}
          {searchMarks.map((mark) => (
            <span
              key={mark.key}
              data-current-search={mark.currentSearch}
              className={`absolute${mark.currentSearch ? ' outline-2 outline-[var(--vds-warning-text-primary)]' : ''}`}
              style={{
                left: `${mark.quad[0] * 100}%`,
                top: `${mark.quad[1] * 100}%`,
                width: `${(mark.quad[2] - mark.quad[0]) * 100}%`,
                height: `${(mark.quad[3] - mark.quad[1]) * 100}%`,
                opacity: mark.opacity,
                background: mark.color,
              }}
            />
          ))}
          {visibleAnnotations.flatMap(({ mark: annotation, quads }) =>
            annotation.style === 'highlight'
              ? quads.map((quad, index) => (
                  <span
                    key={`highlight-${annotation.id}-${index}`}
                    data-pdf-annotation-highlight
                    className={PDF_HIGHLIGHT_VISUAL_CLASS}
                    style={
                      {
                        left: `${quad[0] * 100}%`,
                        top: `${quad[1] * 100}%`,
                        width: `${(quad[2] - quad[0]) * 100}%`,
                        height: `${(quad[3] - quad[1]) * 100}%`,
                        '--pdf-mark-color': PDF_MARK_COLORS[annotation.color],
                        '--pdf-mark-opacity': PDF_HIGHLIGHT_OPACITY,
                      } as React.CSSProperties
                    }
                  />
                ))
              : []
          )}
        </div>
      )}
      {!thumbnail && (
        <div className="vds-pdf-annotation-layer pointer-events-none absolute inset-0 z-[var(--vds-z-local-control)] overflow-hidden">
          {links.map((link) => (
            <Button
              unstyled
              key={link.id}
              aria-label={t('internalLink', { label: link.label || t('internalLinkFallback') })}
              data-testid={`pdf-internal-link-${link.id}`}
              className="pointer-events-auto absolute cursor-pointer rounded-[var(--vds-radius-1)] bg-transparent hover:outline hover:outline-1 hover:outline-[var(--vds-brand-border-default)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vds-brand-border-default)]"
              onClick={() => void onInternalLink?.(link.destination)}
              style={{
                left: `${link.rect[0] * 100}%`,
                top: `${link.rect[1] * 100}%`,
                width: `${(link.rect[2] - link.rect[0]) * 100}%`,
                height: `${(link.rect[3] - link.rect[1]) * 100}%`,
              }}
            />
          ))}
          {externalLinks.map((link, index) => (
            <Button
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
            />
          ))}
          {visibleAnnotations.flatMap(({ mark: annotation, quads }) =>
            quads.map((quad, index) => {
              const color = PDF_MARK_COLORS[annotation.color]
              const hasComment =
                commentMarkIds.includes(annotation.id) && index === quads.length - 1
              const markVisual = pdfMarkVisualClass(annotation.style)
              return (
                <Popover
                  key={`${annotation.id}-${index}`}
                  open={openAnnotation === annotation.id && index === 0}
                  onOpenChange={(open) => {
                    setOpenAnnotation(open ? annotation.id : null)
                    if (open) onAnnotationOpen?.(annotation)
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      unstyled
                      ref={
                        index === 0
                          ? (button) => {
                              if (button) annotationTriggers.current.set(annotation.id, button)
                              else annotationTriggers.current.delete(annotation.id)
                            }
                          : undefined
                      }
                      aria-label={t('pdfAnnotation.location', {
                        page: annotation.page,
                        text: annotation.text,
                      })}
                      data-annotation-id={annotation.id}
                      data-testid={`pdf-mark-${annotation.id}`}
                      className="pointer-events-none absolute cursor-pointer"
                      onClick={
                        index === 0
                          ? undefined
                          : (event) => {
                              event.preventDefault()
                              annotationTriggers.current.get(annotation.id)?.click()
                            }
                      }
                      onMouseUp={(event) => event.stopPropagation()}
                      style={
                        {
                          left: `${quad[0] * 100}%`,
                          top: `${quad[1] * 100}%`,
                          width: `${(quad[2] - quad[0]) * 100}%`,
                          height: `${(quad[3] - quad[1]) * 100}%`,
                          '--pdf-mark-color': color,
                          '--pdf-mark-opacity':
                            annotation.style === 'highlight'
                              ? PDF_HIGHLIGHT_OPACITY
                              : PDF_UNDERLINE_OPACITY,
                          '--pdf-mark-thickness': `${PDF_UNDERLINE_THICKNESS * scale}px`,
                        } as React.CSSProperties
                      }
                    >
                      <span aria-hidden className={`absolute inset-0 ${markVisual}`} />
                      {annotation.style === 'strikethrough' ? (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1/2 w-full border-t-[length:var(--pdf-strikethrough-thickness)] border-t-[var(--pdf-mark-color)] opacity-[var(--pdf-mark-opacity)]"
                          style={
                            {
                              '--pdf-strikethrough-thickness': `${PDF_STRIKETHROUGH_THICKNESS * scale}px`,
                            } as React.CSSProperties
                          }
                        />
                      ) : null}
                      {hasComment ? (
                        <span
                          aria-hidden
                          className="pointer-events-auto absolute -right-3 -top-2.5 grid size-4 place-items-center rounded-full bg-[var(--vds-brand-bg-default)] text-xs font-bold leading-none text-[var(--vds-text-on-brand)] opacity-100"
                        >
                          “
                        </span>
                      ) : null}
                    </Button>
                  </PopoverTrigger>
                  {renderAnnotation ? (
                    <PopoverContent className="z-[var(--vds-z-inline-flyout)] gap-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] p-0">
                      {renderAnnotation(annotation, () => setOpenAnnotation(null))}
                    </PopoverContent>
                  ) : null}
                </Popover>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

export function PdfPageSlot({
  estimatedSize,
  initialPage,
  loadPage,
  pageNumber,
  ...pageProps
}: Omit<PdfPageProps, 'page'> & {
  estimatedSize: Size
  initialPage?: PDFPageProxy
  loadPage: (pageNumber: number) => Promise<PDFPageProxy | null>
  pageNumber: number
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const host = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(Boolean(initialPage))
  const [page, setPage] = useState<PDFPageProxy | null>(initialPage ?? null)
  const focused = Boolean(pageProps.focus)

  useEffect(() => {
    setPage(initialPage ?? null)
    setNear(Boolean(initialPage))
  }, [initialPage, loadPage])

  useEffect(() => {
    const target = host.current
    if (!target || page) return
    const observer = new IntersectionObserver(
      (entries) => setNear(latestIntersection(entries)?.isIntersecting ?? false),
      { rootMargin: NEAR_PAGE_MARGIN }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [page])

  useEffect(() => {
    if ((!near && !focused) || page) return
    let active = true
    void loadPage(pageNumber).then((loaded) => {
      if (active && loaded) setPage(loaded)
    })
    return () => {
      active = false
    }
  }, [focused, loadPage, near, page, pageNumber])

  if (page) return <PdfPage {...pageProps} page={page} />

  const width = estimatedSize.width * pageProps.scale
  const height = estimatedSize.height * pageProps.scale
  return (
    <div
      ref={host}
      className={
        pageProps.thumbnail
          ? 'vds-pdf-thumbnail-page relative overflow-hidden bg-white'
          : 'vds-pdf-page relative mb-[var(--vds-space-4)] flex-shrink-0 bg-white text-[var(--vds-static-black)] leading-none shadow-[var(--vds-shadow-2-center)]'
      }
      data-canvas-rendered="false"
      data-page={pageNumber}
      data-rendered="false"
      data-testid={pageProps.thumbnail ? undefined : `pdf-page-${pageNumber}`}
      data-text-rendered="false"
      style={
        {
          width,
          height,
          '--total-scale-factor': pageProps.scale,
        } as React.CSSProperties
      }
    >
      <span className="vds-pdf-page-placeholder pointer-events-none absolute inset-0 grid place-items-center text-[length:var(--vds-font-body-lv1)]">
        {t('page', { page: pageNumber })}
      </span>
    </div>
  )
}
