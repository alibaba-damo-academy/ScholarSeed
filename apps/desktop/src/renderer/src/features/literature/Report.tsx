import React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ConversationSearchResult, ResultLibraryState } from '../../contracts/literature'
import type { LiteratureSearchViewProps } from './Matches'
import {
  conversationSearchPapers,
  authorizedSearchPapers,
  searchCriteria,
  searchWarningKeys,
  RESULT_LABELS,
  CITATIONS_ORIGIN,
} from './result'
import type { LiteratureResultAuthorization } from './interaction'
import type { HeldFulltextSource } from './join'

const SOURCE_LABELS = {
  success: 'result.sourceStatus.success',
  partial: 'result.sourceStatus.partial',
  failed: 'result.sourceStatus.failed',
  unavailable: 'result.sourceStatus.unavailable',
  execution_blocked: 'result.sourceStatus.execution_blocked',
  transport_error: 'result.sourceStatus.transport_error',
  authentication_error: 'result.sourceStatus.authentication_error',
  unknown: 'result.sourceStatus.unknown',
} as const
const numberLabel = (value: number | null, t: TFunction<'literature'>): string =>
  value === null ? t('searchResult.notRecorded') : String(value)
export function ResultReport({
  View,
  result,
  saved = [],
  libraryStatuses,
  statusWarning = false,
  authorization,
  heldSource,
}: {
  View: React.ComponentType<LiteratureSearchViewProps>
  result: ConversationSearchResult
  saved?: readonly string[]
  libraryStatuses?: Readonly<Record<string, ResultLibraryState>>
  statusWarning?: boolean
  authorization?: LiteratureResultAuthorization
  /** 精确检索卡片才有: 批量加入时可以复用的已下载全文来源。 */
  heldSource?: HeldFulltextSource
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const statusWarningText = statusWarning ? t('result.statusUnavailable') : ''
  const criteria = searchCriteria(result, t)
  const cited = result.origin === CITATIONS_ORIGIN
  const showAbstracts =
    !cited && authorization?.status === 'authorized' && Boolean(authorization.selectedIds?.length)
  const overview = cited
    ? t('result.citationsScope')
    : [
        ...criteria,
        authorization?.status === 'pending'
          ? t('result.pending', { count: result.retained })
          : t('result.counts', {
              candidates: numberLabel(result.candidates, t),
              deduplicated: numberLabel(result.deduplicated, t),
              retained: result.retained,
            }),
        ...result.sources.map((source) =>
          t('result.source', {
            name: source.name,
            status: t(
              Object.prototype.hasOwnProperty.call(SOURCE_LABELS, source.status)
                ? SOURCE_LABELS[source.status as keyof typeof SOURCE_LABELS]
                : 'searchResult.notRecorded'
            ),
            queries: numberLabel(source.queries, t),
            candidates: numberLabel(source.candidates, t),
          })
        ),
        ...searchWarningKeys(result.warnings).map((key) => t(key)),
        statusWarningText,
      ].join('\n\n')
  const status = result.papers.length
    ? 'completed'
    : result.status === 'no_confident_match'
      ? 'empty'
      : 'failed'
  return (
    <View
      query={cited ? t('result.citations') : criteria[0] || t('result.query')}
      papers={authorizedSearchPapers(
        conversationSearchPapers(result.papers),
        cited ? undefined : authorization
      )}
      columnSet={showAbstracts ? 'authorized' : 'candidates'}
      status={status}
      output={overview}
      warning={[
        statusWarningText,
        ...(result.status === 'success' || result.status === 'no_confident_match'
          ? []
          : [t(RESULT_LABELS[result.status as keyof typeof RESULT_LABELS])]),
      ]
        .filter(Boolean)
        .join('；')}
      savedPaperIds={saved}
      libraryStatuses={libraryStatuses}
      heldSource={heldSource}
    />
  )
}
