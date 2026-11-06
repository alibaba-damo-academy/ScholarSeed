import {
  PLUGIN_RPC_ERRORS,
  type PluginCopyContent,
  type PluginReference,
} from '../../../../plugins.ts'
import type { AnswerSource, ConvItem } from '../../model'
import type { i18n } from 'i18next'
import type { InteractionPolicyContribution } from '../../contracts/features'
import { copyCitationLinks } from '../markdown/citations.ts'
import { referenceRanges, visibleMarkdownText } from '../markdown/source.ts'
import { artifactText, deliveryText } from './representation.ts'

const CITATION_AT_END = /\[(\d+)\](?:\([^\n)]*\)|\[[^\n\]]*\])?$/

export function answerCopyText(text: string, sources: readonly AnswerSource[] = []): string {
  const insertions = new Map<number, Set<number>>()
  const references: string[] = []
  const numbers = new Map<string, number>()
  const hidden = referenceRanges(text)
  for (const source of sources) {
    for (const url of source.citation_urls) {
      if (!numbers.has(url)) numbers.set(url, source.number)
    }
    if (source.kind !== 'searched') continue
    references.push(`[${source.number}] ${source.title}\n${source.url}`)
    for (const occurrence of source.occurrences ?? []) {
      const offset = occurrence.end_utf16
      if (!Number.isInteger(offset) || offset <= 0 || offset > text.length) continue
      if (hidden.some((range) => offset > range.start && offset < range.end)) continue
      if (Number(CITATION_AT_END.exec(text.slice(0, offset))?.[1]) === source.number) continue
      const markers = insertions.get(offset) ?? new Set<number>()
      markers.add(source.number)
      insertions.set(offset, markers)
    }
  }
  for (const [offset, markers] of [...insertions].sort(([left], [right]) => right - left)) {
    text =
      text.slice(0, offset) +
      [...markers].map((number) => `[${number}]`).join('') +
      text.slice(offset)
  }
  return [visibleMarkdownText(copyCitationLinks(text, numbers)), ...references]
    .filter(Boolean)
    .join('\n\n')
}

export function hasCopyCard(item: ConvItem): boolean {
  if (item.kind === 'artifact' || item.kind === 'delivery' || item.kind === 'review') return true
  return Boolean(
    item.kind === 'display_card'
      ? item.card.component
      : (item.kind === 'hil' || item.kind === 'interaction_reply') &&
          item.questions?.some((question) => question.component)
  )
}

export async function readCardCopy(
  reference: PluginReference,
  sessionId: string,
  fallback?: (
    data: Record<string, unknown>
  ) => PluginCopyContent | null | Promise<PluginCopyContent | null>,
  data: Record<string, unknown> = {}
): Promise<PluginCopyContent | null> {
  if (!reference.binding || !sessionId) return fallback?.(data) ?? null
  const response = await window.scholarseed.deviceSkills({
    operation: 'plugin-copy',
    reference,
    session_id: sessionId,
  })
  if (response.status >= 400) throw new Error(PLUGIN_RPC_ERRORS.copyFailed)
  const result = JSON.parse(response.body) as {
    content: PluginCopyContent | null
    data?: Record<string, unknown>
    state?: Record<string, unknown>
  }
  const current = { ...data, ...result.data, ...result.state }
  if (typeof data.displayQuestion === 'string') {
    current.displayQuestion = data.displayQuestion
    if (Array.isArray(data.options)) current.options = data.options
    if (Array.isArray(data.answers)) current.answers = data.answers
  }
  return (await fallback?.(current)) ?? result.content
}

export async function replyCopyText(
  items: readonly ConvItem[],
  turnId: string,
  card: (
    reference: PluginReference,
    data: Record<string, unknown>,
    cardId?: string
  ) => Promise<PluginCopyContent | null>,
  missing: string,
  answer: (item: Extract<ConvItem, { kind: 'agent' }>) => string | Promise<string> = (item) =>
    answerCopyText(item.text, item.answerSources),
  presentation?: { policies: readonly InteractionPolicyContribution[]; localization: i18n }
): Promise<string> {
  const parts: string[] = []
  const seen = new Set<string>()
  type Interaction = Extract<ConvItem, { kind: 'hil' | 'interaction_reply' }>
  const interactions = new Map<
    string,
    { item: Interaction; questions: Interaction['questions']; answers: Interaction['answers'] }
  >()
  for (const item of items) {
    if (item.turnId === turnId && (item.kind === 'hil' || item.kind === 'interaction_reply')) {
      const previous = interactions.get(item.requestId)
      interactions.set(item.requestId, {
        item,
        questions: item.questions ?? previous?.questions,
        answers: item.answers ?? previous?.answers,
      })
    }
  }
  for (const item of items) {
    if (item.turnId !== turnId) continue
    if (item.kind === 'agent' && item.text) parts.push(await answer(item))
    if (item.kind === 'artifact') parts.push(artifactText(item.artifact))
    if (item.kind === 'delivery') parts.push(deliveryText(item.delivery))
    if (item.kind === 'review') parts.push(item.review.paths.join('\n'))
    if (item.kind === 'display_card' && item.card.component) {
      const reference = item.card.component
      const identity = reference.binding ?? item.card.cardId
      if (seen.has(identity)) continue
      seen.add(identity)
      parts.push((await card(reference, item.card.content, item.card.cardId))?.text ?? missing)
    }
    if (item.kind === 'hil' || item.kind === 'interaction_reply') {
      const interaction = interactions.get(item.requestId)
      if (interaction?.item !== item) continue
      const policy = presentation?.policies.find((candidate) =>
        candidate.matches(interaction.questions ?? [])
      )
      for (const question of interaction.questions ?? []) {
        if (!question.component) continue
        const identity =
          question.component.binding ?? `${item.requestId}:${question.id ?? question.question}`
        if (seen.has(identity)) continue
        seen.add(identity)
        const rawAnswer = interaction.answers?.[question.id || question.header || question.question]
        const displayed =
          presentation && policy?.presentQuestion?.(question, presentation.localization)
        const questionText = displayed?.question ?? question.question
        const answerText =
          rawAnswer && presentation
            ? (policy?.presentAnswer?.(question, rawAnswer, presentation.localization) ?? rawAnswer)
            : rawAnswer
        const data = {
          question: question.question,
          ...(question.papers
            ? { selected_paper_ids: question.papers.map((paper) => paper.id) }
            : {}),
          ...question.componentData,
          ...(question.papers ? { papers: question.papers } : {}),
          ...(displayed
            ? {
                displayQuestion: questionText,
                options: question.options.map((option, index) => ({
                  ...option,
                  displayLabel: displayed.options[index]?.label ?? option.label,
                  displayDescription: displayed.options[index]?.description ?? option.description,
                })),
                ...(rawAnswer === undefined
                  ? {}
                  : {
                      answers: question.options
                        .filter((option) =>
                          rawAnswer
                            .split('\n')[0]
                            .split(', ')
                            .includes(policy?.optionLabel?.(option) ?? option.label)
                        )
                        .map((option) => option.label),
                    }),
              }
            : {}),
        }
        const ownedContent = presentation
          ? policy?.copyQuestion?.(question, data, presentation.localization)
          : null
        const content = ownedContent ?? (await card(question.component, data))
        const answered =
          answerText &&
          content?.text
            .split('\n')
            .some(
              (line) =>
                line.trim() === answerText ||
                line.trim() === `[x] ${answerText}` ||
                line.trim().startsWith(`[x] ${answerText} `)
            )
        parts.push(
          [
            content?.text.trimStart().startsWith(questionText.trim() + '\n') ||
            content?.text.trim() === questionText.trim()
              ? ''
              : questionText,
            content?.text ?? missing,
            answered ? '' : answerText,
          ]
            .filter(Boolean)
            .join('\n')
        )
      }
    }
  }
  return parts.join('\n\n')
}
