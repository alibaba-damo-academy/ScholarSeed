import type { JSX } from 'react'
import React, { useMemo, useState, type ClipboardEvent, type ReactNode } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import {
  Button,
  CopyButton,
  ScrollArea,
  Tooltip,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  cx,
} from '../ui'
import { Copy, Check, TriangleAlert } from 'lucide-react'
import { remarkAnswerMath } from '../../../../markdown/math.ts'
import { prepareMathSource } from '../../../../markdown/source.ts'
import { writeClipboard, writeClipboardContent } from './clipboard'
import { CARD_HEADER, CARD_ACTIONS, CARD_TABS, CARD_TAB } from './utils'

const FORMULA_OPTIONS = { displayMode: true, trust: false, throwOnError: true } as const
const KATEX_VISUAL_CONTENT = '.katex-html'
const KATEX_STRUCTURED_LINES = '.mtable, .mnewline'

function copyFormulaSelection(event: ClipboardEvent<HTMLElement>): void {
  const selection = event.currentTarget.ownerDocument.getSelection()
  const visual = event.currentTarget.querySelector(KATEX_VISUAL_CONTENT)
  if (
    event.defaultPrevented ||
    !selection ||
    selection.rangeCount !== 1 ||
    selection.isCollapsed ||
    !visual
  ) {
    return
  }
  const range = selection.getRangeAt(0)
  if (!visual.contains(range.startContainer) || !visual.contains(range.endContainer)) return
  const structuredLines = Array.from(visual.querySelectorAll(KATEX_STRUCTURED_LINES))
  if (structuredLines.some((line) => range.intersectsNode(line))) return

  const selected = selection.toString()
  const text = selected.replace(/[ \t]*\r?\n[ \t]*/g, '')
  if (!text || text === selected) return
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
}

export function InlineFormula({
  source,
  pending = false,
}: {
  source: string
  pending?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('ui')
  const rendered = useMemo(() => {
    try {
      return katex.renderToString(source, {
        ...FORMULA_OPTIONS,
        displayMode: false,
        output: 'htmlAndMathml',
      })
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error
      return null
    }
  }, [source])
  return rendered === null ? (
    <Tooltip content={t('markdown.formulaFailed')} disabled={pending}>
      <code data-testid="inline-formula-fallback" tabIndex={0}>
        {source}
      </code>
    </Tooltip>
  ) : (
    <span onCopy={copyFormulaSelection} dangerouslySetInnerHTML={{ __html: rendered }} />
  )
}

const FORMULA_DELIMITERS = [
  ['$$', '$$'],
  ['\\[', '\\]'],
  ['\\(', '\\)'],
  ['$', '$'],
] as const

function formulaSource(source: string): string {
  const trimmed = source.trim()
  for (const [opening, closing] of FORMULA_DELIMITERS) {
    if (
      trimmed.startsWith(opening) &&
      trimmed.endsWith(closing) &&
      trimmed.length > opening.length + closing.length
    ) {
      return trimmed.slice(opening.length, -closing.length)
    }
  }
  return source
}

export interface FormulaProps {
  pending?: boolean
  source: string
  caption?: string
  notes?: string
  onCopy?: (source: string, html?: string) => Promise<void>
}

export function Formula({
  source,
  caption,
  notes,
  onCopy,
  pending = false,
}: FormulaProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [sourceView, setSourceView] = useState(false)
  const latex = formulaSource(source)
  const rendered = useMemo(() => {
    try {
      return {
        html: katex.renderToString(latex, { ...FORMULA_OPTIONS, output: 'htmlAndMathml' }),
        failed: false,
      }
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error
      return { html: '', failed: true }
    }
  }, [latex])
  const showSource = sourceView || rendered.failed
  return (
    <Tabs
      value={showSource ? 'source' : 'formula'}
      onValueChange={(value) => setSourceView(value === 'source')}
      data-testid="conversation-formula"
      className={cx(
        'group/conversation-card !block relative my-[var(--vds-space-3)] min-w-0 max-w-full overflow-hidden rounded-[var(--vds-radius-6)] border border-solid bg-[var(--vds-fill-2)]',
        rendered.failed
          ? 'border-[var(--vds-warning-light-border)]'
          : 'border-[var(--vds-divider-default)]'
      )}
    >
      <div data-testid="formula-toolbar" className={CARD_HEADER}>
        {caption ? (
          <span
            data-testid="formula-caption"
            title={caption}
            className="min-w-0 truncate [font-weight:var(--vds-fw-regular)]"
          >
            {caption}
          </span>
        ) : null}
        <div className={CARD_ACTIONS}>
          <TabsList className={CARD_TABS}>
            <TabsTrigger className={CARD_TAB} value="formula" disabled={rendered.failed}>
              {t('markdown.formula')}
            </TabsTrigger>
            <TabsTrigger className={CARD_TAB} value="source">
              {t('markdown.latex')}
            </TabsTrigger>
          </TabsList>
          {onCopy ? (
            <CopyButton
              key={`${sourceView}:${source}`}
              iconOnly
              icon={<Copy />}
              copiedIcon={<Check />}
              tooltip
              value={showSource ? latex : `\\[${latex}\\]`}
              writeText={(text) =>
                onCopy(
                  text,
                  rendered.failed
                    ? undefined
                    : katex.renderToString(latex, { ...FORMULA_OPTIONS, output: 'mathml' })
                )
              }
              size="xs"
              variant="ghostIcon"
            />
          ) : null}
        </div>
      </div>
      <TabsContent value={showSource ? 'source' : 'formula'}>
        {rendered.failed && !pending ? (
          <p
            role="status"
            className="m-0 flex items-center gap-[var(--vds-space-2)] px-[var(--vds-space-4)] pt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-warning-text-primary)]"
          >
            <TriangleAlert aria-hidden="true" className="size-[var(--vds-icon-8)] shrink-0" />
            {t('markdown.formulaFailed')}
          </p>
        ) : null}
        {showSource ? (
          <ScrollArea
            orientation="horizontal"
            overlay
            viewportProps={{ tabIndex: 0, 'aria-label': t('markdown.latex') }}
          >
            <pre className="m-0 min-w-full whitespace-pre px-[var(--vds-space-3)] py-[var(--vds-space-2)] font-[family-name:var(--font-mono)] text-[length:var(--vds-code-font-size)] leading-[var(--vds-code-line-height)]">
              {source}
            </pre>
          </ScrollArea>
        ) : (
          <ScrollArea
            orientation="horizontal"
            overlay
            viewportProps={{
              'data-testid': 'formula-render',
              tabIndex: 0,
              'aria-label': caption ?? t('markdown.formula'),
            }}
            viewportClassName="overflow-y-hidden [&_.katex-display]:w-max [&_.katex-display]:min-w-full"
          >
            <div
              className="flex min-h-[var(--vds-formula-content-height)] w-max min-w-full items-center justify-center px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[var(--vds-text-primary)] [&_.katex-display]:m-0"
              onCopy={copyFormulaSelection}
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          </ScrollArea>
        )}
      </TabsContent>
      {notes ? (
        <div
          data-testid="formula-notes"
          className="min-w-0 border-t border-dashed border-[var(--vds-border-default)] px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)] [&_p]:my-[var(--vds-space-1)] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden"
        >
          <ReactMarkdown
            skipHtml
            remarkPlugins={[remarkAnswerMath, remarkBreaks]}
            rehypePlugins={[[rehypeKatex, { trust: false }]]}
          >
            {prepareMathSource(notes)}
          </ReactMarkdown>
        </div>
      ) : null}
    </Tabs>
  )
}

/** An answer formula owns its source view and copy representation, never a model request. */
export function AnswerFormula({
  source,
  title,
  inline = false,
  children,
}: {
  source: string
  title?: string
  inline?: boolean
  children?: ReactNode
}): JSX.Element {
  const { t } = useTranslation('components')
  const [sourceView, setSourceView] = useState(false)
  const rendered = useMemo(() => {
    try {
      return {
        html: katex.renderToString(source, {
          displayMode: !inline,
          throwOnError: true,
          trust: false,
          output: 'htmlAndMathml',
        }),
        mathml: katex.renderToString(source, {
          displayMode: !inline,
          throwOnError: true,
          trust: false,
          output: 'mathml',
        }),
      }
    } catch {
      return null
    }
  }, [source, inline])
  if (inline)
    return rendered ? (
      <span className="inline" dangerouslySetInnerHTML={{ __html: rendered.html }} />
    ) : (
      <span
        className="font-[var(--vds-font-code)] text-[var(--vds-text-secondary)]"
        title={t('answer.formulaError')}
      >
        {source}
      </span>
    )
  const raw = sourceView || !rendered
  return (
    <figure className="group/conversation-card relative m-0 min-w-0" data-testid="answer-formula">
      <div className="overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]">
        <div className={CARD_HEADER}>
          {title && (
            <figcaption
              title={title}
              className="mr-auto min-w-0 truncate [font-weight:var(--vds-fw-regular)]"
            >
              {title}
            </figcaption>
          )}
          <div className={CARD_ACTIONS}>
            <Button
              variant="ghost"
              size="xs"
              className={CARD_TAB}
              aria-pressed={!raw}
              disabled={!rendered}
              onClick={() => setSourceView(false)}
            >
              {t('answer.formula')}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className={CARD_TAB}
              aria-pressed={raw}
              onClick={() => setSourceView(true)}
            >
              {t('answer.latex')}
            </Button>
            <CopyButton
              iconOnly
              icon={<Copy />}
              copiedIcon={<Check />}
              variant="ghostIcon"
              size="xs"
              tooltip
              value={raw ? source : `\\[${source}\\]`}
              writeText={
                raw ? writeClipboard : (text) => writeClipboardContent(text, rendered!.mathml)
              }
            />
          </div>
        </div>
        <ScrollArea
          orientation="horizontal"
          viewportProps={{ tabIndex: 0, 'aria-label': title ?? t('answer.formula') }}
        >
          <div className="min-w-full px-[var(--vds-space-4)] py-[var(--vds-space-3)]">
            {raw ? (
              <pre className="m-0 whitespace-pre font-[var(--vds-font-code)] text-[length:var(--vds-font-body-lv1)]">
                {source}
              </pre>
            ) : (
              <div className="text-center" dangerouslySetInnerHTML={{ __html: rendered.html }} />
            )}
          </div>
        </ScrollArea>
      </div>
      {!rendered && (
        <p
          role="status"
          className="mb-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {t('answer.formulaError')}
        </p>
      )}
      {children && (
        <div className="mt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {children}
        </div>
      )}
    </figure>
  )
}
