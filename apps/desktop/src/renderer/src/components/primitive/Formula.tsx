import React, { useMemo, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton } from '../ui'

const FORMULA_OPTIONS = { displayMode: true, trust: false, throwOnError: true } as const

export interface FormulaProps {
  source: string
  caption?: string
  notes?: string
  onCopy?: (source: string, html?: string) => Promise<void>
}

export function Formula({ source, caption, notes, onCopy }: FormulaProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [sourceView, setSourceView] = useState(false)
  const rendered = useMemo(() => {
    try {
      return {
        html: katex.renderToString(source, { ...FORMULA_OPTIONS, output: 'htmlAndMathml' }),
        failed: false,
      }
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error
      return { html: '', failed: true }
    }
  }, [source])
  const showSource = sourceView || rendered.failed
  return (
    <div
      data-testid="conversation-formula"
      className="group my-[var(--vds-space-3)] min-w-0 max-w-full overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)] border-b border-solid border-[var(--vds-border-default)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">
        {caption ? <span className="min-w-0 break-words">{caption}</span> : null}
        <div className="ml-auto flex gap-[var(--vds-space-1)] opacity-0 group-hover:opacity-[var(--vds-opacity-full)] group-focus-within:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:opacity-[var(--vds-opacity-full)]">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!showSource}
            disabled={rendered.failed}
            onClick={() => setSourceView(false)}
          >
            {t('markdown.formula')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={showSource}
            onClick={() => setSourceView(true)}
          >
            {t('markdown.latex')}
          </Button>
          {onCopy ? (
            <CopyButton
              key={`${sourceView}:${source}`}
              value={source}
              writeText={(text) =>
                onCopy(
                  text,
                  showSource
                    ? undefined
                    : katex.renderToString(source, { ...FORMULA_OPTIONS, output: 'mathml' })
                )
              }
              size="sm"
              variant="ghost"
            />
          ) : null}
        </div>
      </div>
      {showSource ? (
        <pre className="m-0 max-w-full overflow-x-auto whitespace-pre px-[var(--vds-space-4)] py-[var(--vds-space-3)] font-[family-name:var(--font-mono)] text-[length:var(--vds-code-font-size)] leading-[var(--vds-code-line-height)]">
          {source}
        </pre>
      ) : (
        <div
          data-testid="formula-render"
          tabIndex={0}
          className="max-w-full overflow-x-auto overflow-y-hidden px-[var(--vds-space-4)] py-[var(--vds-space-1)] [&_.katex-display]:w-max [&_.katex-display]:min-w-full"
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      )}
      {rendered.failed ? (
        <p
          role="status"
          className="m-0 px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[var(--vds-error-text-primary)]"
        >
          {t('markdown.formulaFailed')}
        </p>
      ) : null}
      <div className="border-t border-solid border-[var(--vds-border-default)] px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">
        {notes ? <p className="m-0 whitespace-pre-wrap">{notes}</p> : null}
        <p className="m-0">{t('markdown.formulaValidation')}</p>
      </div>
    </div>
  )
}
