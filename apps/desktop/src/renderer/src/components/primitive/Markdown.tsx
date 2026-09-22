import React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

import type { EvidenceAnnotation, EvidencePriority } from '../../model'
import { isCitationUrl, type CitationLinkRange } from '../../contracts/citations'
import { Button, Checkbox, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui'
import {
  type MarkdownAnswerAnnotation,
  rehypeScholarSeedDecorations
} from '../markdown/decorate'
import { GFM_PLUGIN } from '../markdown/gfm'
import { relativeSessionFilePath } from '../markdown/links'
import { prepareMarkdownSource, visibleMarkdownText } from '../markdown/source'

export { visibleMarkdownText }
export type { MarkdownAnswerAnnotation }

const MARKDOWN_CLASS_NAME = [
  'md min-w-0 max-w-full cursor-text select-text font-[var(--font)] text-[15.5px] font-normal leading-[1.62] text-[var(--text)]',
  '[overflow-wrap:anywhere] break-words [&>*:first-child]:mt-0',
  '[&_strong]:font-semibold [&_strong]:text-[var(--text)] [&_em]:italic',
  /* inline code 用 inline-block + max-w-full：inline 非替换元素不受 max-width 约束，
     带 px/border 的长文件路径 code 会溢出行盒（对话区横向滚动条）；成为 inline-block
     后 max-w-full 生效，短 code 仍内联、长 code 在 chip 内折行。 */
  '[&_code]:inline-block [&_code]:max-w-full [&_code]:align-baseline [&_code]:whitespace-normal [&_code]:rounded-[4px] [&_code]:border [&_code]:border-[var(--border-soft)]',
  '[&_code]:bg-[var(--bg-3)] [&_code]:px-[5px] [&_code]:py-px [&_code]:font-[var(--font-mono)]',
  '[&_code]:text-[0.86em] [&_code]:[overflow-wrap:anywhere] [&_code]:break-words',
  '[&_code]:[-webkit-box-decoration-break:clone] [&_code]:[box-decoration-break:clone]',
  '[&_a]:font-[550] [&_a]:text-[var(--text)] [&_a]:underline'
].join(' ')
const MARKDOWN_PARAGRAPH_CLASS_NAME = 'md-p my-2'
const MARKDOWN_HEADING_CLASS_NAME = 'md-h my-2 mt-4 font-semibold leading-[1.3]'
const MARKDOWN_HEADING_LEVEL_CLASS_NAMES = {
  1: 'md-h1 text-[21px]',
  2: 'md-h2 text-lg',
  3: 'md-h3 text-base text-[var(--text)]',
  4: 'md-h4 text-sm text-[var(--text-2)]',
  5: 'md-h5 text-sm text-[var(--text-2)]',
  6: 'md-h6 text-sm text-[var(--text-2)]'
} as const
const MARKDOWN_LIST_CLASS_NAME = 'my-2 pl-[22px] [&_li]:my-1'
const MARKDOWN_PRE_CLASS_NAME = [
  'md-pre my-2.5 box-border max-w-full overflow-x-auto rounded-lg border border-[var(--border)]',
  'bg-[var(--bg-3)] px-3.5 py-3',
  '[&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[12.5px]',
  '[&_code]:leading-[1.6] [&_code]:text-[var(--text-2)] [&_code]:whitespace-pre-wrap'
].join(' ')
const MARKDOWN_QUOTE_CLASS_NAME = 'md-quote my-2.5 border-0 border-l-2 border-solid border-l-[var(--border)] pl-3 text-[var(--text-2)]'
const MARKDOWN_HR_CLASS_NAME = 'md-hr my-4 border-0 border-t border-solid border-t-[var(--border-soft)]'
const MARKDOWN_TABLE_CLASS_NAME = [
  'md-table my-2.5 block box-border max-w-full overflow-x-auto border-collapse font-[var(--font-sans)] text-[13.5px]',
  '[&_th]:border [&_td]:border [&_th]:border-[var(--border)] [&_td]:border-[var(--border)]',
  '[&_th]:px-[11px] [&_td]:px-[11px] [&_th]:py-1.5 [&_td]:py-1.5',
  '[&_th]:text-left [&_td]:text-left [&_th]:bg-[var(--bg-2)] [&_th]:font-semibold [&_th]:text-[var(--text-2)]'
].join(' ')
const MARKDOWN_ANSWER_ANNOTATION_CLASS_NAME = 'md-answer-annotation rounded-[3px] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-inherit'
const MARKDOWN_ANSWER_ANNOTATION_FOCUSED_CLASS_NAME = 'bg-[color-mix(in_srgb,var(--vds-notice-5)_28%,transparent)] ring-2 ring-[var(--vds-notice-5)] ring-offset-2 ring-offset-[var(--vds-bg-page)]'
const EMPTY_CITATION_URLS: string[] = []

const EVIDENCE_COLORS: Record<EvidencePriority, string> = {
  supported: 'var(--c-experience)',
  mixed: 'var(--c-opinion)',
  limited: 'var(--c-tension)',
  unverified: 'var(--text-3)'
}

const EVIDENCE_LABEL_KEYS = {
  supported: 'evidence.priority.supported',
  mixed: 'evidence.priority.mixed',
  limited: 'evidence.priority.limited',
  unverified: 'evidence.priority.unverified'
} as const satisfies Record<EvidencePriority, string>

const URL_REFERENCE_PREFIX = 'url:'
const SOURCE_PREVIEW_LIMIT = 260

type EvidenceSourcePreview = {
  ref: string
  title: string
  excerpt: string
  externalUrl: string
}

function safeExternalUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function externalUrlFromReference(reference: string): string {
  const value = reference.startsWith(URL_REFERENCE_PREFIX)
    ? reference.slice(URL_REFERENCE_PREFIX.length)
    : reference
  return safeExternalUrl(value)
}

function sourceFallbackTitle(reference: string, t: TFunction<'assistant'>): string {
  const url = externalUrlFromReference(reference)
  if (url) {
    try {
      return new URL(url).hostname
    } catch {
      return t('evidence.sources.external')
    }
  }
  const kind = reference.split(':', 1)[0]
  if (kind === 'paper') return t('evidence.sources.paper')
  if (kind === 'paper_anchor') return t('evidence.sources.paperAnchor')
  if (kind === 'experiment') return t('evidence.sources.experiment')
  return t('evidence.sources.research')
}

function sourcePreview(reference: string, t: TFunction<'assistant'>): EvidenceSourcePreview {
  const directUrl = externalUrlFromReference(reference)
  if (directUrl) {
    return {
      ref: reference,
      title: sourceFallbackTitle(reference, t),
      excerpt: t('evidence.externalExcerpt'),
      externalUrl: directUrl
    }
  }
  return {
    ref: reference,
    title: sourceFallbackTitle(reference, t),
    excerpt: reference.slice(0, SOURCE_PREVIEW_LIMIT),
    externalUrl: ''
  }
}

function useEvidenceSourcePreviews(
  sourceRefs: string[], active: boolean, t: TFunction<'assistant'>
): Record<string, EvidenceSourcePreview> {
  const sourceKey = sourceRefs.join('\u001f')
  return React.useMemo(
    () => active
      ? Object.fromEntries(sourceRefs.map((reference) => [reference, sourcePreview(reference, t)]))
      : {},
    [active, sourceKey, t]
  )
}

function openExternalSource(url: string): void {
  if (!url) return
  if (window.scholarseed?.openExternal) {
    void window.scholarseed.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noreferrer')
}

function EvidenceReferenceSpan({
  annotation,
  terminal,
  children
}: {
  annotation: EvidenceAnnotation
  terminal: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [hovered, setHovered] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const color = EVIDENCE_COLORS[annotation.priority]
  const sources = annotation.source_refs.slice(0, 3)
  const citationText = annotation.citation_nums.map((num) => `[${num}]`).join('')
  const previews = useEvidenceSourcePreviews(annotation.source_refs, hovered || expanded, t)
  const toggle = (event: React.MouseEvent | React.KeyboardEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    setExpanded((current) => !current)
  }
  const openExternal = (event: React.MouseEvent, url: string): void => {
    event.preventDefault()
    event.stopPropagation()
    openExternalSource(url)
  }
  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative', display: 'inline' }}
    >
      <button
        type="button"
        data-testid="evidence-reference"
        aria-label={t('evidence.referenceLabel', { priority: t(EVIDENCE_LABEL_KEYS[annotation.priority]), citation: citationText || t('evidence.unnumbered') })}
        aria-expanded={expanded}
        onClick={toggle}
        style={{
          padding: 0,
          border: 0,
          cursor: 'pointer',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'inherit',
          textDecorationLine: 'underline',
          textDecorationColor: color,
          textDecorationStyle: annotation.priority === 'limited' ? 'dashed' : 'solid',
          textDecorationThickness: 2,
          textUnderlineOffset: 3,
          background: `color-mix(in srgb, ${color} 10%, transparent)`,
          borderRadius: 2
        }}
      >
        {children}
        {terminal && <sup style={{ marginLeft: 3, color, fontSize: 9, fontWeight: 700 }}>{citationText || '[?]'}</sup>}
      </button>
      {expanded && (
        <span
          role="region"
          aria-label={t('evidence.claimCard')}
          style={{
            display: 'block',
            margin: '9px 0 12px',
            padding: '11px 12px',
            border: `1px solid ${color}`,
            borderLeft: `3px solid ${color}`,
            borderRadius: 8,
            background: 'var(--bg-2)',
            boxShadow: 'var(--shadow)',
            color: 'var(--text)',
            fontSize: 11,
            lineHeight: 1.5,
            textDecoration: 'none'
          }}
        >
          <span style={{ display: 'block', color, fontWeight: 700 }}>{t(EVIDENCE_LABEL_KEYS[annotation.priority])} · {citationText || t('evidence.unnumbered')}</span>
          <span style={{ display: 'block', marginTop: 5, color: 'var(--text)', fontSize: 12, fontWeight: 600 }}>{t('evidence.claim')}</span>
          <span style={{ display: 'block', marginTop: 3, color: 'var(--text-2)' }}>{children}</span>
          {sources.length ? (
            <span style={{ display: 'block', marginTop: 10 }}>
              <span style={{ display: 'block', color: 'var(--text)', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{t('evidence.references')}</span>
              {sources.map((source, index) => {
                const preview = previews[source] ?? sourcePreview(source, t)
                return (
                  <span key={source} style={{ display: 'block', padding: '8px 9px', marginTop: 5, border: '1px solid var(--border-soft)', borderRadius: 6, background: 'var(--bg)' }}>
                    <span style={{ display: 'block', color: 'var(--text)', fontSize: 11.5, fontWeight: 600 }}>{annotation.citation_nums[index] ? `[${annotation.citation_nums[index]}] ` : ''}{preview.title}</span>
                    <span style={{ display: 'block', marginTop: 3, color: 'var(--text-2)', fontSize: 10.5 }}>{preview.excerpt || t('evidence.previewUnavailable')}</span>
                    <span style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                      {preview.externalUrl && <button type="button" data-testid={`evidence-open-external:${annotation.citation_nums[index] ?? index}`} onClick={(event) => openExternal(event, preview.externalUrl)} style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--accent-ink)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>{t('evidence.openOriginal')}</button>}
                    </span>
                  </span>
                )
              })}
            </span>
          ) : null}
        </span>
      )}
      {hovered && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 30,
            left: 0,
            top: 'calc(100% + 8px)',
            width: 250,
            padding: '10px 11px',
            border: `1px solid ${color}`,
            borderRadius: 9,
            background: 'var(--bg-2)',
            boxShadow: 'var(--shadow)',
            color: 'var(--text)',
            fontSize: 11,
            lineHeight: 1.45,
            textDecoration: 'none',
            cursor: 'default'
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <span style={{ display: 'block', color, fontWeight: 700 }}>{t(EVIDENCE_LABEL_KEYS[annotation.priority])} · {t('evidence.sourceCount', { count: annotation.source_refs.length })}</span>
          <span style={{ display: 'block', marginTop: 5, color: 'var(--text-2)' }}>{children}</span>
          {sources.length ? (
            <span style={{ display: 'block', marginTop: 6, color: 'var(--text-2)' }}>
              {sources.map((source, index) => {
                const preview = previews[source] ?? sourcePreview(source, t)
                return `${annotation.citation_nums[index] ? `[${annotation.citation_nums[index]}] ` : ''}${preview.title}`
              }).join(' · ')}{annotation.source_refs.length > sources.length ? ' …' : ''}
            </span>
          ) : null}
          <span style={{ display: 'block', marginTop: 7, color: 'var(--accent-ink)' }}>{t('evidence.expandClaim')}</span>
        </span>
      )}
    </span>
  )
}

interface MarkdownRenderOptions {
  evidence: Map<string, EvidenceAnnotation>
  annotations: Map<string, MarkdownAnswerAnnotation>
  citationUrls: ReadonlySet<string>
  renderMarker?: (annotation: MarkdownAnswerAnnotation) => React.ReactNode
  renderCitation?: (range: CitationLinkRange, children: React.ReactNode, href: string) => React.ReactNode
  onOpenSessionFile?: (path: string) => void
  renderSessionFileLink?: (path: string, children: React.ReactNode) => React.ReactNode
}
const MarkdownRenderContext = React.createContext<MarkdownRenderOptions>({
  evidence: new Map(), annotations: new Map(), citationUrls: new Set()
})

function markdownComponents(): Components {
  return {
    p: ({ node: _node, ...props }) => <p className={MARKDOWN_PARAGRAPH_CLASS_NAME} {...props} />,
    h1: ({ node: _node, ...props }) => <h1 className={`${MARKDOWN_HEADING_CLASS_NAME} ${MARKDOWN_HEADING_LEVEL_CLASS_NAMES[1]}`} {...props} />,
    h2: ({ node: _node, ...props }) => <h2 className={`${MARKDOWN_HEADING_CLASS_NAME} ${MARKDOWN_HEADING_LEVEL_CLASS_NAMES[2]}`} {...props} />,
    h3: ({ node: _node, ...props }) => <h3 className={`${MARKDOWN_HEADING_CLASS_NAME} ${MARKDOWN_HEADING_LEVEL_CLASS_NAMES[3]}`} {...props} />,
    h4: ({ node: _node, ...props }) => <h4 className={`${MARKDOWN_HEADING_CLASS_NAME} ${MARKDOWN_HEADING_LEVEL_CLASS_NAMES[4]}`} {...props} />,
    h5: ({ node: _node, ...props }) => <h5 className={`${MARKDOWN_HEADING_CLASS_NAME} ${MARKDOWN_HEADING_LEVEL_CLASS_NAMES[5]}`} {...props} />,
    h6: ({ node: _node, ...props }) => <h6 className={`${MARKDOWN_HEADING_CLASS_NAME} ${MARKDOWN_HEADING_LEVEL_CLASS_NAMES[6]}`} {...props} />,
    ul: ({ node: _node, ...props }) => <ul className={`md-ul list-disc ${MARKDOWN_LIST_CLASS_NAME}`} {...props} />,
    ol: ({ node: _node, ...props }) => <ol className={`md-ol list-decimal ${MARKDOWN_LIST_CLASS_NAME}`} {...props} />,
    blockquote: ({ node: _node, ...props }) => <blockquote className={MARKDOWN_QUOTE_CLASS_NAME} {...props} />,
    hr: ({ node: _node, ...props }) => <hr className={MARKDOWN_HR_CLASS_NAME} {...props} />,
    pre: ({ node: _node, ...props }) => <pre className={MARKDOWN_PRE_CLASS_NAME} {...props} />,
    table: ({ node: _node, ...props }) => <Table className={MARKDOWN_TABLE_CLASS_NAME} density="compact" {...props} />,
    thead: ({ node: _node, ...props }) => <TableHeader {...props} />,
    tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
    tr: ({ node: _node, ...props }) => <TableRow {...props} />,
    th: ({ node: _node, ...props }) => <TableHead {...props} />,
    td: ({ node: _node, ...props }) => <TableCell {...props} />,
    input: ({ node: _node, checked }) => {
      const { t } = useTranslation('ui')
      return <Checkbox
        aria-label={t(checked ? 'markdown.taskComplete' : 'markdown.taskIncomplete')}
        checked={Boolean(checked)}
        className="md-task-checkbox"
        disabled
      />
    },
    a: ({ node: _node, href, children, ...props }) => {
      const { citationUrls, renderCitation, onOpenSessionFile, renderSessionFileLink } = React.useContext(MarkdownRenderContext)
      if (renderCitation && href && (isCitationUrl(href) || citationUrls.has(href))) {
        const start = _node?.position?.start.offset
        const end = _node?.position?.end.offset
        if (start !== undefined && end !== undefined) {
          const citation = renderCitation({ start, end }, children, href)
          if (citation !== undefined && citation !== null) return <>{citation}</>
        }
      }
      const url = safeExternalUrl(href ?? '')
      const filePath = (onOpenSessionFile || renderSessionFileLink) && href ? relativeSessionFilePath(href) : null
      if (filePath) {
        if (renderSessionFileLink) return <>{renderSessionFileLink(filePath, children)}</>
        return <Button
          unstyled
          className="inline cursor-pointer border-0 bg-transparent p-0 [font:inherit] text-[var(--vds-link)] underline hover:text-[var(--vds-link-hover)] focus-visible:[box-shadow:var(--vds-focus-brand)]"
          data-testid="session-file-link"
          onClick={() => onOpenSessionFile?.(filePath)}
        >{children}</Button>
      }
      return url
        ? <a {...props} href={url} rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); openExternalSource(url) }}>{children}</a>
        : <span>{children}</span>
    },
    img: ({ node: _node, alt }) => {
      const { t } = useTranslation('ui')
      return <span className="md-image-placeholder">{alt || t('markdown.image')}</span>
    },
    mark: ({ node: _node, className: _className, ...props }) => {
      const focused = (props as Record<string, unknown>)[
        'data-scholarseed-answer-annotation-focused'
      ] === 'true'
      return (
        <mark
          className={`${MARKDOWN_ANSWER_ANNOTATION_CLASS_NAME} ${
            focused ? MARKDOWN_ANSWER_ANNOTATION_FOCUSED_CLASS_NAME : ''
          }`}
          {...props}
        />
      )
    },
    span: ({ node: _node, children, ...props }) => {
      const { evidence, annotations, renderMarker } = React.useContext(MarkdownRenderContext)
      const data = props as Record<string, unknown>
      const evidenceId = data['data-scholarseed-evidence-id'] as string | undefined
      const markerId = data['data-scholarseed-answer-marker'] as string | undefined
      if (evidenceId) {
        const annotation = evidence.get(evidenceId)
        if (annotation) {
          return (
            <EvidenceReferenceSpan
              annotation={annotation}
              terminal={data['data-scholarseed-evidence-terminal'] === 'true'}
            >
              {children}
            </EvidenceReferenceSpan>
          )
        }
      }
      const marker = markerId ? annotations.get(markerId) : undefined
      if (marker) return <>{renderMarker?.(marker)}</>
      return <span {...props}>{children}</span>
    }
  }
}

const MARKDOWN_COMPONENTS = markdownComponents()

export function Markdown({
  text,
  className,
  math,
  texMath = false,
  orderedLists: _orderedLists = false,
  evidence = [],
  sourceMapped = false,
  answerAnnotations = [],
  renderAnswerAnnotationMarker,
  renderCitation,
  onOpenSessionFile,
  renderSessionFileLink,
  citationUrls = EMPTY_CITATION_URLS
}: {
  text: string
  className?: string
  math?: boolean
  texMath?: boolean
  orderedLists?: boolean
  evidence?: EvidenceAnnotation[]
  sourceMapped?: boolean
  answerAnnotations?: MarkdownAnswerAnnotation[]
  renderAnswerAnnotationMarker?: (annotation: MarkdownAnswerAnnotation) => React.ReactNode
  renderCitation?: (range: CitationLinkRange, children: React.ReactNode, href: string) => React.ReactNode
  onOpenSessionFile?: (path: string) => void
  renderSessionFileLink?: (path: string, children: React.ReactNode) => React.ReactNode
  citationUrls?: string[]
}): React.JSX.Element {
  const renderMath = math ?? texMath
  const source = String(text || '')
  const renderedSource = prepareMarkdownSource(source)
  const evidenceById = React.useMemo(
    () => new Map(evidence.map((annotation) => [annotation.claim_ref, annotation])),
    [evidence]
  )
  const answersById = React.useMemo(
    () => new Map(answerAnnotations.map((annotation) => [annotation.id, annotation])),
    [answerAnnotations]
  )
  const citationUrlSet = React.useMemo(() => new Set(citationUrls), [citationUrls])
  const renderOptions = React.useMemo(
    () => ({ evidence: evidenceById, annotations: answersById, citationUrls: citationUrlSet, renderMarker: renderAnswerAnnotationMarker, renderCitation, onOpenSessionFile, renderSessionFileLink }),
    [answersById, citationUrlSet, evidenceById, renderAnswerAnnotationMarker, renderCitation, onOpenSessionFile, renderSessionFileLink]
  )
  const decoration = React.useMemo(
    () => rehypeScholarSeedDecorations({ source, sourceMapped, evidence, answers: answerAnnotations, citationUrls: citationUrlSet }),
    [answerAnnotations, citationUrlSet, evidence, source, sourceMapped]
  )
  return (
    <MarkdownRenderContext.Provider value={renderOptions}><div className={`${MARKDOWN_CLASS_NAME} ${className ?? ''}`}>
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        rehypePlugins={renderMath ? [decoration, rehypeKatex] : [decoration]}
        remarkPlugins={renderMath ? [GFM_PLUGIN, remarkCjkFriendly, remarkBreaks, remarkMath] : [GFM_PLUGIN, remarkCjkFriendly, remarkBreaks]}
        skipHtml
        urlTransform={(url) => renderCitation && (isCitationUrl(url) || citationUrlSet.has(url))
          ? url
          : (onOpenSessionFile || renderSessionFileLink) && relativeSessionFilePath(url) ? url : safeExternalUrl(url)}
      >
        {renderedSource}
      </ReactMarkdown>
    </div></MarkdownRenderContext.Provider>
  )
}
