import type { ReactNode } from 'react'
import { Check, Copy, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CopyButton, ScrollArea, cx } from '../ui'

export interface TabulationProps {
  framed?: boolean
  pending?: boolean
  children?: ReactNode
  invalidSource?: string
  copyText?: string
  caption?: string
  notes?: string
  onCopy?: (source: string) => Promise<void>
}

export function Tabulation({
  framed = true,
  pending = false,
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
    <>
      <div
        data-testid="conversation-table"
        className={cx(
          'group/conversation-table relative isolate min-w-0 max-w-full overflow-hidden',
          framed &&
            'my-[var(--vds-space-3)] rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-divider-default)]'
        )}
      >
        <div className="relative">
          <ScrollArea
            orientation="both"
            overlay
            overlayVerticalInsetSelector="thead"
            className="max-h-[var(--vds-conversation-table-max-height)] max-w-full"
            viewportProps={{
              'data-testid': 'table-scroll',
              tabIndex: 0,
              'aria-label': caption ?? t('markdown.table'),
            }}
            viewportClassName={cx(
              '[&_table]:w-full [&_table]:border-collapse [&_table]:font-[family-name:var(--font-sans)] [&_table]:text-[length:var(--vds-font-body-lv2)] [&_table]:leading-[var(--vds-lh-body-lv2)] [&_table]:text-[var(--vds-text-primary)]',
              '[&_th]:min-w-[var(--vds-conversation-table-cell-min-width)] [&_td]:min-w-[var(--vds-conversation-table-cell-min-width)] [&_th]:max-w-[var(--vds-conversation-table-cell-max-width)] [&_td]:max-w-[var(--vds-conversation-table-cell-max-width)] [&_tr>*]:px-[var(--vds-space-3)] [&_tr>*]:py-[var(--vds-space-2)] [&_tbody_td]:[font-weight:var(--vds-fw-regular)] [&_tr>*]:text-[var(--vds-text-primary)] [&_td]:whitespace-normal [&_th]:whitespace-normal [&_td]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere]',
              '[&_tr]:border-0 [&_tr:not(:last-child)>*]:border-b-[length:var(--vds-conversation-table-divider-width)] [&_thead_tr>*]:border-b-[length:var(--vds-conversation-table-divider-width)] [&_tr>*:not(:last-child)]:border-r-[length:var(--vds-conversation-table-divider-width)] [&_tr>*]:border-solid [&_tr>*]:border-[var(--vds-divider-default)]',
              '[&_tbody_td]:bg-[var(--vds-fill-2)] [&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[var(--vds-z-content)] [&_tbody_tr>*:first-child]:bg-[var(--vds-fill-2)] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[var(--vds-z-content)] [&_thead_th]:bg-[var(--vds-fill-4)] [&_thead_tr>*:first-child]:z-[var(--vds-z-local-control)]'
            )}
          >
            {invalidSource === undefined ? (
              children
            ) : (
              <pre className="m-0 whitespace-pre px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
                {invalidSource}
              </pre>
            )}
          </ScrollArea>
          {onCopy && copyText !== undefined ? (
            <div
              data-testid="table-copy-control"
              className="pointer-events-none absolute bottom-[var(--vds-space-2)] right-[var(--vds-space-2)] z-[var(--vds-z-local-control)] opacity-0 group-hover/conversation-table:pointer-events-auto group-hover/conversation-table:opacity-[var(--vds-opacity-full)] group-focus-within/conversation-table:pointer-events-auto group-focus-within/conversation-table:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-[var(--vds-opacity-full)]"
            >
              <CopyButton
                key={copyText}
                value={copyText}
                writeText={onCopy}
                iconOnly
                icon={<Copy />}
                copiedIcon={<Check />}
                tooltip
                size="md"
                variant="icon"
              />
            </div>
          ) : null}
        </div>
        {notes ? (
          <p
            role="note"
            className="m-0 whitespace-pre-wrap px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] leading-[var(--vds-lh-body-lv3)] text-[var(--vds-text-secondary)] [overflow-wrap:anywhere]"
          >
            {notes}
          </p>
        ) : null}
      </div>
      {invalidSource !== undefined && !pending ? (
        <p
          role="status"
          className="flex items-start gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-tertiary)]"
        >
          <Info aria-hidden="true" className="shrink-0" size="1em" />
          <span>{t('markdown.tableIncomplete')}</span>
        </p>
      ) : null}
    </>
  )
}
