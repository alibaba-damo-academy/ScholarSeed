import type { JSX } from 'react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Search,
} from 'lucide-react'
import {
  Button,
  CopyButton,
  IconButton,
  Link,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  cx,
} from '../ui'
import { writeClipboard } from './clipboard'

export interface AnswerColumn {
  id: string
  label: string
  numeric?: boolean
}
export function AnswerTable({
  columns,
  rows,
  caption,
  copyText,
}: {
  columns: readonly AnswerColumn[]
  rows: readonly { id: string; cells: readonly ReactNode[] }[]
  caption?: ReactNode
  copyText: string
}): JSX.Element {
  return (
    <figure className="group/table relative m-0 min-w-0" data-testid="answer-table">
      <div className="mb-[var(--vds-space-1)] flex justify-end opacity-0 group-hover/table:opacity-[var(--vds-opacity-full)] group-focus-within/table:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:opacity-[var(--vds-opacity-full)]">
        <CopyButton
          iconOnly
          icon={<Copy />}
          copiedIcon={<Check />}
          variant="ghostIcon"
          size="xs"
          tooltip
          value={copyText}
          writeText={writeClipboard}
        />
      </div>
      <div className="overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]">
        <ScrollArea orientation="horizontal" viewportProps={{ tabIndex: 0 }}>
          <Table density="compact" className="w-full">
            <TableHeader className="bg-[var(--vds-surface-muted)]">
              <TableRow>
                {columns.map((column, index) => (
                  <TableHead
                    key={column.id}
                    className={cx(
                      'whitespace-nowrap',
                      index === 0 &&
                        'sticky left-0 z-[var(--vds-z-sticky-header)] bg-[var(--vds-surface-muted)]',
                      column.numeric && '!text-right'
                    )}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  {row.cells.map((cell, index) => (
                    <TableCell
                      key={columns[index].id}
                      className={cx(
                        'align-top',
                        index === 0 &&
                          'sticky left-0 z-[var(--vds-z-sticky-header)] bg-[var(--vds-bg-white-default)]',
                        columns[index].numeric && '!text-right tabular-nums'
                      )}
                    >
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>
      {caption && (
        <figcaption className="mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}

export interface AnswerSearchResult {
  id: string
  title: string
  url: string
  site: string
  description: string
}
const SEARCH_PREVIEW_COUNT = 3
export function AnswerSearchResults({
  title,
  queries,
  results,
  onOpen,
}: {
  title: string
  queries?: readonly string[]
  results: readonly AnswerSearchResult[]
  onOpen: (result: AnswerSearchResult) => void
}): JSX.Element {
  const { t } = useTranslation('components')
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="min-w-0" data-testid="answer-search">
      <h3 className="mb-[var(--vds-space-3)] mt-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)]">
        {title}
      </h3>
      {queries?.length ? (
        <div className="mb-[var(--vds-space-3)] grid gap-[var(--vds-space-2)]">
          {queries.map((query) => (
            <div
              key={query}
              className="flex items-start gap-[var(--vds-space-2)] text-[var(--vds-text-secondary)]"
            >
              <Search className="size-[var(--vds-icon-7)] shrink-0" />
              <span>{query}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid gap-[var(--vds-space-4)]">
        {(expanded ? results : results.slice(0, SEARCH_PREVIEW_COUNT)).map((result) => (
          <article key={result.id} className="min-w-0">
            <div className="mb-[var(--vds-space-1)] flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
              <Globe className="size-[var(--vds-icon-6)]" />
              {result.site}
            </div>
            <Tooltip content={result.title}>
              <Link
                href={result.url}
                className="block truncate font-[var(--vds-fw-medium)]"
                onClick={(event) => {
                  event.preventDefault()
                  onOpen(result)
                }}
              >
                {result.title}
              </Link>
            </Tooltip>
            <p className="mb-0 mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {result.description}
            </p>
          </article>
        ))}
      </div>
      {results.length > SEARCH_PREVIEW_COUNT && (
        <Button
          className="mt-[var(--vds-space-3)]"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
          {expanded
            ? t('answer.collapse')
            : t('answer.moreResults', { count: results.length - SEARCH_PREVIEW_COUNT })}
        </Button>
      )}
    </section>
  )
}

export function AnswerCanvas({
  title,
  children,
  onOpen,
  icon = <FileText />,
  defaultExpanded = true,
}: {
  title: string
  children: ReactNode
  onOpen: () => void
  icon?: ReactNode
  defaultExpanded?: boolean
}): JSX.Element {
  const { t } = useTranslation('components')
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <section
      data-testid="answer-canvas"
      className="min-w-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]"
    >
      <header className="flex min-w-0 items-center gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
        <span className="shrink-0 text-[var(--vds-text-secondary)] [&>svg]:size-[var(--vds-icon-7)]">
          {icon}
        </span>
        <Tooltip content={title}>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start truncate"
            onClick={onOpen}
          >
            {title}
          </Button>
        </Tooltip>
        <Tooltip content={t('answer.openWorkbench')}>
          <IconButton
            label={t('answer.openWorkbench')}
            icon={<ExternalLink />}
            size="xs"
            variant="ghostIcon"
            onClick={onOpen}
          />
        </Tooltip>
        <Tooltip content={expanded ? t('answer.collapse') : t('answer.expand')}>
          <IconButton
            label={expanded ? t('answer.collapse') : t('answer.expand')}
            aria-expanded={expanded}
            icon={expanded ? <ChevronDown /> : <ChevronRight />}
            size="xs"
            variant="ghostIcon"
            onClick={() => setExpanded(!expanded)}
          />
        </Tooltip>
      </header>
      <div hidden={!expanded} className="border-t border-[var(--vds-divider-default)]">
        <ScrollArea
          className="max-h-[var(--vds-layout-search-row-max-height)]"
          viewportProps={{ tabIndex: 0, 'aria-label': title }}
        >
          <div className="p-[var(--vds-space-4)]">{children}</div>
        </ScrollArea>
      </div>
    </section>
  )
}
