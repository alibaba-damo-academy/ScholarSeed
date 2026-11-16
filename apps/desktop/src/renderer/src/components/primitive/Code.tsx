import type { JSX } from 'react'
import React, { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton, ScrollArea } from '../ui'
import { codeTokens } from './highlight'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { writeClipboard } from './clipboard'
import { encodedBoundaries, type SourceLeaf } from '../markdown/source'
import { SourceBoundary } from './Recovery'
import { CARD_HEADER, CARD_ACTIONS } from './utils'

const COLLAPSED_LINES = 12
const CODE_BODY =
  'm-0 max-w-full overflow-x-auto bg-[var(--vds-fill-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] font-[family-name:var(--vds-code-font-family)] text-[length:var(--vds-code-font-size)] leading-[var(--vds-code-line-height)] text-[var(--vds-code-text)]'

const CODE_LABELS = {
  code: 'markdown.code',
  command: 'markdown.command',
  output: 'markdown.output',
} as const

export interface CodeProps {
  embedded?: boolean
  sourceMap?: SourceLeaf
  code: string
  language?: string
  mode?: 'code' | 'command' | 'output'
  onCopy?: (source: string) => Promise<void>
}

export function Code(props: CodeProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <SourceBoundary source={props.code} message={t('markdown.codeFailed')} onCopy={props.onCopy}>
      <CodeContent {...props} />
    </SourceBoundary>
  )
}

function CodeContent({
  embedded = false,
  code,
  language,
  mode = 'code',
  onCopy,
  sourceMap,
}: CodeProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const lines = code.replace(/\n$/, '').split('\n')
  const tokens = useMemo(
    () => codeTokens(code.replace(/\n$/, ''), mode === 'code' ? language : undefined),
    [code, language, mode]
  )
  const collapsible = lines.length > COLLAPSED_LINES
  const visible = collapsible && !expanded ? lines.slice(0, COLLAPSED_LINES) : lines
  let sourceOffset = 0
  return (
    <div
      data-testid="conversation-code"
      className={
        embedded
          ? 'min-w-0 max-w-full overflow-hidden'
          : 'group/conversation-card my-[var(--vds-space-3)] min-w-0 max-w-full overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-divider-default)]'
      }
    >
      {!embedded ? (
        <div className={CARD_HEADER}>
          <span className="min-w-0 truncate [font-weight:var(--vds-fw-regular)]">
            {language || t(CODE_LABELS[mode])}
          </span>
          {onCopy ? (
            <span className={CARD_ACTIONS}>
              <CopyButton
                iconOnly
                icon={<Copy />}
                copiedIcon={<Check />}
                tooltip
                key={code}
                value={code}
                writeText={onCopy}
                size="xs"
                variant="ghostIcon"
              />
            </span>
          ) : null}
        </div>
      ) : null}
      <pre id={contentId} tabIndex={0} className={CODE_BODY}>
        <code className="!block !max-w-none !border-0 !bg-transparent !p-0 !text-[length:inherit] !text-inherit !whitespace-pre !break-normal ![overflow-wrap:normal]">
          {visible.map((line, index) => {
            const start = sourceMap?.boundaries[sourceOffset]
            const end = sourceMap?.boundaries[sourceOffset + line.length]
            const mapping =
              sourceMap && typeof start === 'number' && typeof end === 'number'
                ? {
                    'data-md-source-start': start,
                    'data-md-source-end': end,
                    'data-md-source-boundaries': encodedBoundaries({
                      value: line,
                      startUtf16: start,
                      endUtf16: end,
                      boundaries: sourceMap.boundaries.slice(
                        sourceOffset,
                        sourceOffset + line.length + 1
                      ),
                    }),
                  }
                : {}
            sourceOffset += line.length + 1
            return (
              <React.Fragment key={index}>
                <span
                  {...mapping}
                  data-code-line={index + 1}
                  className={
                    mode === 'code'
                      ? 'before:inline-block before:box-content before:w-[var(--vds-code-gutter)] before:pr-[var(--vds-space-3)] before:text-right before:text-[var(--vds-text-tertiary)] before:content-[attr(data-code-line)] before:select-none'
                      : undefined
                  }
                >
                  {tokens[index]?.map((token, tokenIndex) => (
                    <span key={tokenIndex} className={token.className}>
                      {token.text}
                    </span>
                  )) ?? line}
                </span>
                {index < visible.length - 1 ? '\n' : null}
              </React.Fragment>
            )
          })}
        </code>
      </pre>
      {collapsible ? (
        <div className="flex justify-between border-t border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-1)]">
          <Button
            variant="ghost"
            size="sm"
            className="!border-0 !px-0 !text-[length:var(--vds-font-body-lv1)] !text-[var(--vds-text-tertiary)]"
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

const CODE_PREVIEW_LINES = 12

export function AnswerCode({
  source,
  language,
  output = false,
}: {
  source: string
  language: string
  output?: boolean
}): JSX.Element {
  const { t } = useTranslation('components')
  const [expanded, setExpanded] = useState(false)
  const lines = source.split('\n')
  const tokens = useMemo(
    () => codeTokens(source, output ? undefined : language),
    [source, language, output]
  )
  const collapsible = lines.length > CODE_PREVIEW_LINES
  return (
    <div
      data-testid="answer-code"
      className="group/conversation-card min-w-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-divider-default)]"
    >
      <div className={CARD_HEADER}>
        <span className="min-w-0 truncate [font-weight:var(--vds-fw-regular)]">
          {output ? t('answer.output') : language}
        </span>
        <span className={CARD_ACTIONS}>
          <CopyButton
            iconOnly
            icon={<Copy />}
            copiedIcon={<Check />}
            variant="ghostIcon"
            size="xs"
            tooltip
            value={source}
            writeText={writeClipboard}
          />
        </span>
      </div>
      <ScrollArea orientation="horizontal" viewportProps={{ tabIndex: 0, 'aria-label': language }}>
        <pre className={CODE_BODY}>
          <code className="!block !max-w-none !border-0 !bg-transparent !p-0 !text-[length:inherit] !text-inherit !whitespace-pre !break-normal ![overflow-wrap:normal]">
            {(collapsible && !expanded ? tokens.slice(0, CODE_PREVIEW_LINES) : tokens).map(
              (line, index, visible) => (
                <React.Fragment key={index}>
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} className={token.className}>
                      {token.text}
                    </span>
                  ))}
                  {index < visible.length - 1 ? '\n' : null}
                </React.Fragment>
              )
            )}
          </code>
        </pre>
      </ScrollArea>
      {collapsible && (
        <Button
          className="w-full border-t border-[var(--vds-divider-default)]"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
          {expanded ? t('answer.collapse') : t('answer.expandLines', { count: lines.length })}
        </Button>
      )}
    </div>
  )
}
