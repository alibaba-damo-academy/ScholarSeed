import React, { useRef, useState } from 'react'
import { BookOpenText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Alert, AlertDescription } from '../../components/ui'
import { Receipt } from '../../components/primitive/Receipt'
import { CITATIONS_ORIGIN, RESULT_LABELS } from './result'
import type { ConversationSearchPaper, ConversationSearchResult } from '../../contracts/literature'
import type { LiteratureCardPorts } from './ports'

const SEARCH_CARD_VERSION = '1.0'

export function literatureResultTitle(
  result: ConversationSearchResult,
  t: TFunction<'literature'>
): string {
  return result.origin === CITATIONS_ORIGIN
    ? `${t('result.citations')} ${t('review.paperCount', { count: result.retained })}`
    : t('result.searchReceipt', { total: result.retained })
}

export function parseResult(content: Record<string, unknown>): ConversationSearchResult | null {
  if (
    content.schema_version !== SEARCH_CARD_VERSION ||
    typeof content.session_id !== 'string' ||
    typeof content.status !== 'string' ||
    !Object.prototype.hasOwnProperty.call(RESULT_LABELS, content.status) ||
    !Array.isArray(content.papers) ||
    !Array.isArray(content.criteria) ||
    !Array.isArray(content.sources) ||
    !Array.isArray(content.warnings)
  )
    return null
  return content as unknown as ConversationSearchResult
}

export function LiteratureResultReceipt({
  title,
  count,
  description,
  icon,
  compact,
  openLabel,
  onOpen,
  preview,
  inlinePreview,
  previewCollapsible,
  openButtonSize,
  defaultExpanded,
  previewOverlay,
  previewOverlayScrollOnly,
  previewPlacement,
  previewViewportClassName,
  previewContentClassName,
}: {
  title: string
  count?: string
  description?: string
  icon?: React.ReactNode
  compact?: boolean
  openLabel?: string
  onOpen: () => Promise<void>
  preview?: React.ReactNode
  inlinePreview?: boolean
  previewCollapsible?: boolean
  openButtonSize?: React.ComponentProps<typeof Receipt>['openButtonSize']
  defaultExpanded?: boolean
  previewOverlay?: boolean
  previewOverlayScrollOnly?: boolean
  previewPlacement?: React.ComponentProps<typeof Receipt>['previewPlacement']
  previewViewportClassName?: string
  previewContentClassName?: string
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const open = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      await onOpen()
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="contents">
      <Receipt
        title={title}
        description={description}
        count={count}
        icon={icon}
        iconAppearance={compact ? 'outline' : 'bordered'}
        openButtonText={compact ? undefined : t('result.searchReceiptView')}
        compact={compact}
        busy={busy}
        openLabel={openLabel ?? t('result.viewAll')}
        onOpen={() => void open()}
        preview={preview}
        inlinePreview={inlinePreview}
        previewCollapsible={previewCollapsible}
        openButtonSize={openButtonSize}
        defaultExpanded={defaultExpanded}
        expandLabel={t('result.expandPreview')}
        collapseLabel={t('result.collapsePreview')}
        previewOverlay={previewOverlay}
        previewOverlayScrollOnly={previewOverlayScrollOnly}
        previewPlacement={previewPlacement}
        previewViewportClassName={previewViewportClassName}
        previewContentClassName={previewContentClassName}
      />
      {failed && (
        <Alert tone="error">
          <AlertDescription>{t('result.openFailed')}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function SearchPreview({ papers }: { papers: ConversationSearchPaper[] }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const rowClass =
    'flex h-[var(--vds-literature-search-result-line-height)] min-w-0 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-2)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]'

  return (
    <div className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
      {papers.length ? (
        <ul role="list" className="m-0 grid list-none gap-[var(--vds-space-1)] p-0">
          {papers.map((paper) => (
            <li key={paper.id} className={rowClass}>
              <BookOpenText aria-hidden className="size-[var(--vds-icon-6)] shrink-0" />
              <span
                className="min-w-0 flex-1 truncate font-[var(--vds-fw-regular)]"
                title={paper.title}
              >
                {paper.title}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={rowClass}>{t('search.status.empty')}</div>
      )}
    </div>
  )
}

export function LiteratureResults({
  content,
  ports,
}: {
  content: Record<string, unknown>
  ports: LiteratureCardPorts
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const result = parseResult(content)
  if (!result)
    return (
      <Alert tone="warning">
        <AlertDescription>{t('result.unreadable')}</AlertDescription>
      </Alert>
    )
  const citations = result.origin === CITATIONS_ORIGIN
  return (
    <LiteratureResultReceipt
      title={literatureResultTitle(result, t)}
      description={citations ? t('search.literature') : t('result.searchReceiptSubtitle')}
      icon={<BookOpenText />}
      defaultExpanded
      previewCollapsible={false}
      previewOverlay
      previewOverlayScrollOnly
      previewPlacement="inside"
      previewViewportClassName="max-h-[var(--vds-literature-search-preview-height)] overscroll-contain"
      previewContentClassName="px-[var(--vds-space-3)]"
      preview={<SearchPreview papers={result.papers} />}
      onOpen={ports.openResults}
    />
  )
}
