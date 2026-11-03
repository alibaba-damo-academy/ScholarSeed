import i18next from 'i18next'
import type { CitationResolution } from '../../contracts/citations'
import type { ConvItem } from '../../model'
import { answerCopyText } from '../../components/business/copying.ts'
import { citationPreviewUrl, citationSources } from './api.ts'
import { sha256Text } from './anchors.ts'

const CITATION_COPY_UNAVAILABLE = 'citation_sources_unavailable'
const CITATION_STATUS = {
  exact: 'citations.status.exact',
  source_only: 'citations.status.sourceOnly',
  unavailable: 'citations.status.unavailable',
  changed: 'citations.status.changed',
} as const
type Answer = Extract<ConvItem, { kind: 'agent' }>

export async function copyAnswer(
  item: Answer,
  sessionId: string,
  load = citationSources,
  preview = citationPreviewUrl
): Promise<string> {
  const receipts = item.answerSources?.filter((source) => source.kind === 'receipt') ?? []
  const text = answerCopyText(item.text, item.answerSources)
  if (!receipts.length) return text
  const answerId = item.itemId
    ? `item:${item.itemId}`
    : item.eventSeq !== undefined
      ? `answer:${item.eventSeq}`
      : ''
  if (!answerId || !sessionId) throw new Error(CITATION_COPY_UNAVAILABLE)
  const result = await load(sessionId, answerId, await sha256Text(item.text))
  const sources = new Map<string, CitationResolution>(
    result.sources.map((source) => [source.handle, source])
  )
  const references = receipts.map((receipt) => {
    const source = sources.get(receipt.handle)
    if (!source) throw new Error(CITATION_COPY_UNAVAILABLE)
    const pages = source.pages.length
      ? i18next.t('citations.pages', {
          ns: 'assistant',
          pages: source.pages.map((page) => page.page).join(', '),
        })
      : ''
    return [
      `[${receipt.number}] ${source.title}`,
      i18next.t(CITATION_STATUS[source.state], { ns: 'assistant' }),
      pages,
      source.quote,
      source.state !== 'unavailable' ? preview(source) : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  return [text, ...references].join('\n\n')
}
