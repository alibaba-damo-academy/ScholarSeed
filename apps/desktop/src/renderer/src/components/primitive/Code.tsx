import React, { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton } from '../ui'

const COLLAPSED_LINES = 12
const CODE_LABELS = {
  code: 'markdown.code',
  command: 'markdown.command',
  output: 'markdown.output',
} as const

export interface CodeProps {
  code: string
  language?: string
  mode?: 'code' | 'command' | 'output'
  onCopy?: (source: string) => Promise<void>
}

export function Code({ code, language, mode = 'code', onCopy }: CodeProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const lines = code.replace(/\n$/, '').split('\n')
  const collapsible = lines.length > COLLAPSED_LINES
  const visible = collapsible && !expanded ? lines.slice(0, COLLAPSED_LINES) : lines
  return (
    <div
      data-testid="conversation-code"
      className="group my-[var(--vds-space-3)] min-w-0 max-w-full overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
    >
      <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)] border-b border-solid border-[var(--vds-border-default)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">
        <span className="min-w-0 break-words">{language || t(CODE_LABELS[mode])}</span>
        {onCopy ? (
          <CopyButton
            key={code}
            value={code}
            writeText={onCopy}
            size="sm"
            variant="ghost"
            className="shrink-0 opacity-0 group-hover:opacity-[var(--vds-opacity-full)] group-focus-within:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:opacity-[var(--vds-opacity-full)]"
          />
        ) : null}
      </div>
      <pre
        id={contentId}
        tabIndex={0}
        className="m-0 max-w-full overflow-x-auto py-[var(--vds-space-2)] font-[family-name:var(--font-mono)] text-[length:var(--vds-code-font-size)] leading-[var(--vds-code-line-height)] text-[var(--vds-text-secondary)]"
      >
        <code className="!block !max-w-none !border-0 !bg-transparent !p-0 !text-[length:inherit] !text-inherit !whitespace-pre !break-normal ![overflow-wrap:normal]">
          {visible.map((line, index) => (
            <React.Fragment key={index}>
              <span
                data-code-line={index + 1}
                className={
                  mode === 'code'
                    ? 'before:inline-block before:w-[var(--vds-code-gutter)] before:pr-[var(--vds-space-3)] before:text-right before:text-[var(--vds-text-tertiary)] before:content-[attr(data-code-line)] before:select-none'
                    : 'pl-[var(--vds-space-3)]'
                }
              >
                {line}
              </span>
              {index < visible.length - 1 ? '\n' : null}
            </React.Fragment>
          ))}
        </code>
      </pre>
      {collapsible ? (
        <div className="flex justify-between border-t border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-1)]">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t('markdown.collapseCode')
              : t('markdown.expandCode', { count: lines.length })}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
