import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '../ui'

export interface TabulationProps {
  children?: ReactNode
  invalidSource?: string
  copyText?: string
  caption?: string
  notes?: string
  onCopy?: (source: string) => Promise<void>
}

export function Tabulation({
  children,
  copyText: tableText,
  invalidSource,
  caption,
  notes,
  onCopy,
}: TabulationProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const copyText = invalidSource ?? tableText
  return (
    <div
      data-testid="conversation-table"
      className="group isolate my-[var(--vds-space-3)] min-w-0 max-w-full overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
    >
      {caption || (onCopy && copyText !== undefined) ? (
        <div className="flex items-center justify-between gap-[var(--vds-space-2)] border-b border-solid border-[var(--vds-border-default)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">
          {caption ? <span className="min-w-0 break-words">{caption}</span> : null}
          {onCopy && copyText !== undefined ? (
            <CopyButton
              key={copyText}
              value={copyText}
              writeText={onCopy}
              size="sm"
              variant="ghost"
              className="ml-auto shrink-0 opacity-0 group-hover:opacity-[var(--vds-opacity-full)] group-focus-within:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:opacity-[var(--vds-opacity-full)]"
            />
          ) : null}
        </div>
      ) : null}
      <div
        data-testid="table-scroll"
        tabIndex={0}
        className="max-w-full overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_th]:min-w-[var(--vds-conversation-table-cell-min-width)] [&_td]:min-w-[var(--vds-conversation-table-cell-min-width)] [&_th]:max-w-[var(--vds-conversation-table-cell-max-width)] [&_td]:max-w-[var(--vds-conversation-table-cell-max-width)] [&_td]:whitespace-normal [&_th]:whitespace-normal [&_td]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere] [&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[var(--vds-z-content)] [&_tr>*:first-child]:bg-[var(--vds-surface-raised)] [&_thead_tr>*:first-child]:bg-[var(--vds-surface-muted)]"
      >
        {invalidSource === undefined ? (
          children
        ) : (
          <>
            <p
              role="status"
              className="m-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]"
            >
              {t('markdown.tableIncomplete')}
            </p>
            <pre className="m-0 whitespace-pre px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
              {invalidSource}
            </pre>
          </>
        )}
      </div>
      {notes ? (
        <p className="m-0 whitespace-pre-wrap border-t border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]">
          {notes}
        </p>
      ) : null}
    </div>
  )
}
