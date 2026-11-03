import React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpenText } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EllipsisText,
} from '../../components/ui'
import { conversationSearchPapers, searchWarningKeys, RESULT_LABELS } from './result'
import type { ConversationSearchResult } from '../../contracts/literature'
import type { LiteratureCardPorts } from './ports'

const PREVIEW_PAPERS = 3
const SEARCH_CARD_VERSION = '1.0'

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
  const selectedCorpus = Boolean(result.selection?.artifact_id)
  const warnings = searchWarningKeys(result.warnings).map((key) => t(key))
  return (
    <Card
      className="min-w-0 [--vds-card-radius:var(--vds-radius-6)]"
      data-testid="literature-search-preview"
    >
      <CardHeader>
        <CardTitle className="!text-[length:var(--vds-font-body-lv2)] !font-[var(--vds-fw-medium)] !text-[var(--vds-text-primary)]">
          {t('result.heading', {
            heading: selectedCorpus
              ? t('searchResult.authorizationPending')
              : t(RESULT_LABELS[result.status as keyof typeof RESULT_LABELS]),
            count: result.retained,
          })}
        </CardTitle>
        <CardDescription className="line-clamp-2 text-[var(--vds-text-tertiary)]">
          {result.criteria[0] || t('result.search')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-[var(--vds-space-2)]">
          <div className="grid gap-[var(--vds-library-result-paper-gap)]">
            {conversationSearchPapers(result.papers.slice(0, PREVIEW_PAPERS)).map((paper) => (
              <div
                key={paper.paper_id}
                className="flex min-w-0 items-center gap-[var(--vds-library-result-paper-gap)] rounded-[var(--vds-library-result-paper-radius)] bg-[var(--vds-bg-gray-default-transparent)] p-[var(--vds-library-result-paper-padding)]"
              >
                <BookOpenText
                  aria-hidden
                  className="shrink-0 text-[var(--vds-icon-outline-default)]"
                  size={14}
                />
                <EllipsisText
                  className="text-[length:var(--vds-library-result-paper-font-size)] text-[var(--vds-text-secondary)]"
                  wrapperClassName="min-w-0 flex-1"
                  tooltipPortalled
                >
                  {paper.title}
                  {paper.year ? ` · ${paper.year}` : ''}
                </EllipsisText>
              </div>
            ))}
          </div>
          {warnings.length > 0 && (
            <p className="m-0 line-clamp-2 text-[var(--vds-text-secondary)]">{warnings[0]}</p>
          )}
          <Button variant="outline" onClick={() => void ports.openResults()}>
            {t('result.viewAll')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
