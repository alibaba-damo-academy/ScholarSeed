import React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ConversationSearchResult, ResultLibraryState } from '../../contracts/literature'
import type { LiteratureSearchViewProps } from './Matches'
import { conversationSearchPapers, searchWarningKeys, RESULT_LABELS } from './result'

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
  libraryStatuses = {},
  statusWarning = false,
}: {
  View: React.ComponentType<LiteratureSearchViewProps>
  result: ConversationSearchResult
  saved?: readonly string[]
  libraryStatuses?: Readonly<Record<string, ResultLibraryState>>
  statusWarning?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const statusWarningText = statusWarning ? t('result.statusUnavailable') : ''
  const overview = [
    ...result.criteria,
    result.selection?.artifact_id
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
      query={result.criteria[0] || t('result.query')}
      papers={conversationSearchPapers(result.papers)}
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
    />
  )
}
