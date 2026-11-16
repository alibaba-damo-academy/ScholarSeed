import i18next, { type i18n } from 'i18next'

import type { InteractionPolicyContribution, InteractionQuestion } from '../../contracts/features'
import { LITERATURE_AUTHORIZATION_SLOTS } from '../../contracts/literature.ts'
import { PUBLIC_COMPONENT_PLUGIN } from '../../../../plugins.ts'
import type { ConvItem } from '../../model'
import { literatureCopy } from './copy.ts'
import { parseReview, searchSupersessionKey } from './projection.ts'

const PDF = /(^|\b)pdf($|\b)|latex/i
const MARKDOWN = /markdown/i
const NUMERIC = /数字|numeric/i
const AUTHOR_YEAR = /作者.*年|author.?year/i
const PUBLISHER = /出版|publisher/i
const IEEE = /ieee/i
const ACM = /acm/i
const OUTPUT_HEADER = '综述输出格式'
const CITATION_HEADER = '综述引用格式'
const PUBLISHER_HEADER = '综述出版社格式'
const AUTHORIZATION_HEADERS = new Set([
  '综述检索授权',
  '精准检索授权',
  '想法原文授权',
  '文献全文授权',
])
const AUTHORIZE = '一键授权'
const REJECT = '拒绝'
export const LITERATURE_AUTHORIZATION_LABELS = [AUTHORIZE, REJECT] as const

export function literatureAuthorizationSource(source?: string) {
  if (source === 'user_explicit') return undefined
  return source === 'auto_delegated'
    ? 'review.authorization.automaticGranted'
    : 'review.authorization.unknownGranted'
}

export function fulltextSelection(
  question: InteractionQuestion,
  values: Record<string, unknown>,
  selectable: boolean,
  requireSelection = false
): string[] | null {
  const selected = values.selected_paper_ids
  const papers = question.papers ?? []
  if (
    !Array.isArray(selected) ||
    selected.some((id) => typeof id !== 'string' || !papers.some((paper) => paper.id === id)) ||
    new Set(selected).size !== selected.length ||
    (!selectable && selected.length !== papers.length) ||
    (requireSelection && selectable && selected.length === 0)
  )
    return null
  return selected as string[]
}

function metadataSnapshot(content: Record<string, unknown>): string | null {
  const search = searchSupersessionKey(content)
  const metadata = content.metadata
  if (!search || !metadata || typeof metadata !== 'object') return null
  const { path, sha256 } = metadata as Record<string, unknown>
  return typeof path === 'string' && path && typeof sha256 === 'string' && sha256
    ? JSON.stringify([search, path, sha256])
    : null
}

function authorizationSnapshot(content: Record<string, unknown>): string | null {
  const search = searchSupersessionKey(content)
  const selection = content.selection
  if (!search || !selection || typeof selection !== 'object') return null
  const { path, sha256 } = selection as Record<string, unknown>
  return typeof path === 'string' && path && typeof sha256 === 'string' && sha256
    ? JSON.stringify([search, path, sha256, metadataSnapshot(content)])
    : null
}

function authorizationCardIds(items: readonly ConvItem[], cardId: string): Set<string> {
  const ids = new Set([cardId])
  const current = items.find((item) => item.kind === 'display_card' && item.card.cardId === cardId)
  const snapshot =
    current?.kind === 'display_card' && current.card.type === 'literature-search'
      ? authorizationSnapshot(current.card.content)
      : null
  const metadata =
    !snapshot && current?.kind === 'display_card' && current.card.type === 'literature-search'
      ? metadataSnapshot(current.card.content)
      : null
  if (snapshot || metadata)
    for (const item of items)
      if (
        item.kind === 'display_card' &&
        item.card.type === 'literature-search' &&
        (snapshot
          ? authorizationSnapshot(item.card.content) === snapshot
          : metadataSnapshot(item.card.content) === metadata)
      )
        ids.add(item.card.cardId)
  return ids
}

export function literatureAuthorizationRequest(items: readonly ConvItem[], cardId: string) {
  const ids = authorizationCardIds(items, cardId)
  const item = [...items]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === 'hil' &&
        candidate.questions?.some((question) => ids.has(question.resultCardId ?? ''))
    )
  return item?.kind === 'hil' ? item : undefined
}

export interface LiteratureResultAuthorization {
  status: 'pending' | 'authorized' | 'rejected' | 'unknown'
  selectedIds?: string[]
}

export function literatureResultAuthorization(
  items: readonly ConvItem[],
  cardId: string
): LiteratureResultAuthorization {
  const item = literatureAuthorizationRequest(items, cardId)
  if (!item) return { status: 'unknown' }
  if (
    !item.hilState ||
    item.timedOut ||
    item.hilState === 'unknown' ||
    item.hilState === 'stale' ||
    item.hilState === 'cancelled'
  )
    return { status: 'unknown' }
  if (item.hilState !== 'resolved') return { status: 'pending' }
  const ids = authorizationCardIds(items, cardId)
  const question = item.questions?.find((candidate) => ids.has(candidate.resultCardId ?? ''))
  const answer = question && item.answers?.[question.id || question.header || question.question]
  if (!answer) return { status: 'unknown' }
  const selectedIds = item.selectedPaperIds
    ? item.selectedPaperIds.filter(
        (id) => !question?.papers || question.papers.some((paper) => paper.id === id)
      )
    : question?.papers?.map((paper) => paper.id)
  if (authorizationLabel(answer) === REJECT || selectedIds?.length === 0)
    return { status: 'rejected' }
  return authorizationLabel(answer) === AUTHORIZE
    ? { status: 'authorized', selectedIds }
    : { status: 'unknown' }
}
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i
const AUTHORIZATION_COPY = [
  {
    prefix: 'library-fulltext:',
    reauthorizable: false,
    selectable: true,
    header: 'review.authorization.libraryHeader',
    question: 'review.authorization.libraryQuestion',
  },
  {
    prefix: 'precise-search-fulltext:',
    reauthorizable: true,
    selectable: true,
    header: 'review.authorization.preciseHeader',
    question: 'review.authorization.preciseQuestion',
  },
  {
    prefix: 'literature-review-fulltext:',
    reauthorizable: true,
    selectable: false,
    header: 'review.authorization.reviewHeader',
    question: 'review.authorization.reviewQuestion',
  },
  {
    prefix: 'research-idea-fulltext:',
    reauthorizable: true,
    selectable: false,
    header: 'review.authorization.ideaHeader',
    question: 'review.authorization.ideaQuestion',
  },
] as const
const AUTHORIZATION_OPTIONS = {
  [AUTHORIZE]: {
    labelKey: 'review.authorization.authorize',
    descriptionKey: 'review.authorization.authorizeDescription',
  },
  [REJECT]: {
    labelKey: 'review.authorization.reject',
    descriptionKey: 'review.authorization.rejectDescription',
  },
} as const

function authorizationCopy(question: InteractionQuestion) {
  return AUTHORIZATION_COPY.find((copy) => question.id?.startsWith(copy.prefix))
}

export function literatureAuthorizationRetryable(question: InteractionQuestion): boolean {
  return authorizationCopy(question)?.reauthorizable === true
}

function presentAuthorizationQuestion(
  question: InteractionQuestion,
  localization: i18n
): InteractionQuestion {
  const copy = authorizationCopy(question)
  if (!copy) return question
  return {
    ...question,
    header: localization.t(copy.header, { ns: 'literature' }),
    question: `${localization.t(copy.question, { ns: 'literature' })}\n${localization.t('review.authorization.scopeNotice', { ns: 'literature' })}`,
    options: question.options.map((option) => {
      const label = authorizationLabel(option.label)
      if (label !== AUTHORIZE && label !== REJECT) return option
      const optionCopy = AUTHORIZATION_OPTIONS[label]
      return {
        ...option,
        label: localization.t(optionCopy.labelKey, { ns: 'literature' }),
        description: localization.t(optionCopy.descriptionKey, { ns: 'literature' }),
      }
    }),
  }
}

function presentAuthorizationAnswer(
  question: InteractionQuestion,
  answer: string,
  localization: i18n
): string {
  if (!authorizationCopy(question) || (answer !== AUTHORIZE && answer !== REJECT)) return answer
  return localization.t(AUTHORIZATION_OPTIONS[answer].labelKey, { ns: 'literature' })
}

function authorizationLabel(label: string): string {
  return label.replace(RECOMMENDED_SUFFIX, '')
}

function labels(question: InteractionQuestion): string[] {
  return question.options.map((option) => option.label)
}

function includes(question: InteractionQuestion, pattern: RegExp): boolean {
  return labels(question).some((label) => pattern.test(label))
}

function isPrimary(questions: readonly InteractionQuestion[]): boolean {
  return (
    questions.some(
      (question) =>
        question.header === OUTPUT_HEADER && includes(question, PDF) && includes(question, MARKDOWN)
    ) &&
    questions.some(
      (question) =>
        question.header === CITATION_HEADER &&
        includes(question, NUMERIC) &&
        includes(question, AUTHOR_YEAR) &&
        includes(question, PUBLISHER)
    )
  )
}

function isPublisherFollowup(questions: readonly InteractionQuestion[]): boolean {
  return (
    questions.length === 1 &&
    questions[0].header === PUBLISHER_HEADER &&
    includes(questions[0], IEEE) &&
    includes(questions[0], ACM)
  )
}

function isRetrievalAuthorization(questions: readonly InteractionQuestion[]): boolean {
  if (
    questions.length === 1 &&
    questions[0].component?.plugin === PUBLIC_COMPONENT_PLUGIN &&
    Object.values(LITERATURE_AUTHORIZATION_SLOTS).some(
      (slot) => questions[0].component?.component === slot
    )
  )
    return true
  const optionLabels = questions[0]?.options.map((option) => authorizationLabel(option.label)) ?? []
  return (
    questions.length === 1 &&
    AUTHORIZATION_HEADERS.has(questions[0].header ?? '') &&
    optionLabels.length === 2 &&
    optionLabels.includes(AUTHORIZE) &&
    optionLabels.includes(REJECT)
  )
}

function defaultFor(question: InteractionQuestion): string {
  const option =
    question.options.find((candidate) => MARKDOWN.test(candidate.label)) ??
    question.options.find((candidate) => NUMERIC.test(candidate.label))
  return option?.label ?? i18next.t('review.interactionDefault', { ns: 'literature' })
}

export const literatureReviewInteraction = {
  id: 'slr-output-spec',
  get title() {
    return i18next.t('review.interactionTitle', { ns: 'literature' })
  },
  matches: (questions) => isPrimary(questions) || isPublisherFollowup(questions),
  complete: (questions, answers, texts) =>
    questions.every(
      (question, index) =>
        (question.options.length > 0 && (answers[index]?.length ?? 0) > 0) ||
        Boolean(texts[index]?.trim())
    ),
  defaults: (questions) =>
    Object.fromEntries(
      questions.map((question) => [
        question.id || question.header || question.question,
        isPublisherFollowup(questions)
          ? i18next.t('review.interactionDefault', { ns: 'literature' })
          : defaultFor(question),
      ])
    ),
  get defaultLabel() {
    return i18next.t('review.interactionDefaultLabel', { ns: 'literature' })
  },
} satisfies InteractionPolicyContribution

function authorizationPolicy(
  id: string,
  matches: (questions: readonly InteractionQuestion[]) => boolean
): InteractionPolicyContribution {
  return {
    id,
    get title() {
      return i18next.t('review.authorizationTitle', { ns: 'literature' })
    },
    matches,
    directDecision: () => 'respond',
    directPresentation: 'primary-secondary',
    directSelectionRequired: (option) => authorizationLabel(option.label) === AUTHORIZE,
    optionLabel: (option) => authorizationLabel(option.label),
    isPrimaryOption: (option) => authorizationLabel(option.label) === AUTHORIZE,
    selectablePapers: id === 'precise-fulltext-subset-authorization',
    composerAttached: true,
    replyTitle: (_question, answer, localization) =>
      authorizationLabel(answer) === AUTHORIZE
        ? localization.t('review.authorizationReplyTitle', { ns: 'literature' })
        : undefined,
    replyText: (_question, answer, localization) => {
      const label = authorizationLabel(answer)
      if (label === AUTHORIZE)
        return localization.t('review.authorizationReplyGranted', { ns: 'literature' })
      if (label === REJECT)
        return localization.t('review.authorizationReplyRejected', { ns: 'literature' })
      return undefined
    },
    presentQuestion: presentAuthorizationQuestion,
    presentAnswer: presentAuthorizationAnswer,
    get cancelledLabel() {
      return () => i18next.t('review.authorizationCancelled', { ns: 'literature' })
    },
  }
}

function isSubsetAuthorization(questions: readonly InteractionQuestion[]): boolean {
  const question = questions[0]
  return (
    questions.length === 1 &&
    authorizationCopy(question)?.selectable === true &&
    (question?.papers?.length ?? 0) > 0 &&
    isRetrievalAuthorization(questions)
  )
}

export const preciseFulltextSubsetAuthorization = authorizationPolicy(
  'precise-fulltext-subset-authorization',
  isSubsetAuthorization
)

export const literatureRetrievalAuthorization: InteractionPolicyContribution = {
  ...authorizationPolicy('literature-corpus-authorization', isRetrievalAuthorization),
  showQuestionDetails: false,
  replyTitle: (_question, answer, localization) => {
    const label = authorizationLabel(answer)
    if (label === AUTHORIZE)
      return localization.t('review.authorization.compactGrantedTitle', { ns: 'literature' })
    if (label === REJECT)
      return localization.t('review.authorization.compactRejectedTitle', { ns: 'literature' })
    return undefined
  },
  replyText: (_question, answer, localization) => {
    const label = authorizationLabel(answer)
    if (label === AUTHORIZE)
      return localization.t('review.authorization.compactGrantedText', { ns: 'literature' })
    if (label === REJECT)
      return localization.t('review.authorization.compactRejectedText', { ns: 'literature' })
    return undefined
  },
}

const SEARCH_START_KIND = 'precise-search-start'
const SEARCH_START_OPTIONS = ['start', 'defer'] as const

function isSearchStart(question: InteractionQuestion): boolean {
  return (
    question.presentation?.kind === SEARCH_START_KIND &&
    !!question.id?.startsWith(`${SEARCH_START_KIND}:`) &&
    !question.component &&
    !question.multiSelect &&
    question.options.length === SEARCH_START_OPTIONS.length &&
    SEARCH_START_OPTIONS.every((action, index) => question.options[index].label === action)
  )
}

export const preciseSearchStartInteraction: InteractionPolicyContribution = {
  id: SEARCH_START_KIND,
  title: (localization) => localization.t('searchStart.title', { ns: 'literature' }),
  matches: (questions) => questions.length === 1 && isSearchStart(questions[0]),
  directDecision: () => 'respond',
  presentQuestion: (question, localization) => {
    if (!isSearchStart(question)) return question
    const t = localization.getFixedT(null, 'literature')
    return {
      ...question,
      header: t('searchStart.title'),
      question: t('searchStart.question'),
      options: [
        { label: t('searchStart.start'), description: t('searchStart.startDescription') },
        { label: t('searchStart.defer'), description: t('searchStart.deferDescription') },
      ],
    }
  },
  presentAnswer: (question, answer, localization) => {
    if (!isSearchStart(question)) return answer
    const t = localization.getFixedT(null, 'literature')
    if (answer === SEARCH_START_OPTIONS[0]) return t('searchStart.start')
    if (answer === SEARCH_START_OPTIONS[1]) return t('searchStart.defer')
    return answer
  },
}

const CURATION_KIND = 'literature-curation'
const CURATION_PREFIX = 'literature-curation-'
const CURATION_OPTIONS = {
  确认执行: { labelKey: 'curation.confirm', descriptionKey: 'curation.confirmDescription' },
  取消: { labelKey: 'curation.cancel', descriptionKey: 'curation.cancelDescription' },
} as const
const CURATION_OPTION_COUNT = Object.keys(CURATION_OPTIONS).length

function curationPresentation(question: InteractionQuestion) {
  const presentation = question.presentation
  if (
    !question.id?.startsWith(CURATION_PREFIX) ||
    presentation?.kind !== CURATION_KIND ||
    typeof presentation.operation !== 'string' ||
    !presentation.operation ||
    typeof presentation.count !== 'number' ||
    !Number.isSafeInteger(presentation.count) ||
    presentation.count < 0 ||
    !Array.isArray(presentation.titles) ||
    !presentation.titles.every((title: unknown) => typeof title === 'string') ||
    question.multiSelect ||
    question.options.length !== CURATION_OPTION_COUNT ||
    new Set(question.options.map((option) => option.label)).size !== CURATION_OPTION_COUNT ||
    !question.options.every((option) =>
      Object.prototype.hasOwnProperty.call(CURATION_OPTIONS, option.label)
    )
  )
    return null
  return {
    operation: presentation.operation,
    count: presentation.count,
    titles: presentation.titles as string[],
  }
}

export const literatureCurationInteraction: InteractionPolicyContribution = {
  id: CURATION_KIND,
  title: (localization) => localization.t('curation.header', { ns: 'literature' }),
  matches: (questions) => questions.length === 1 && curationPresentation(questions[0]) !== null,
  presentQuestion: (question, localization) => {
    const presentation = curationPresentation(question)
    if (!presentation) return question
    const t = localization.getFixedT(null, 'literature')
    return {
      ...question,
      header: t('curation.header'),
      question: t('curation.question', {
        operation: presentation.operation,
        count: presentation.count,
        titles: presentation.titles.join(t('curation.separator')) || t('curation.unknown'),
      }),
      options: question.options.map((option) => {
        const copy = CURATION_OPTIONS[option.label as keyof typeof CURATION_OPTIONS]
        return { ...option, label: t(copy.labelKey), description: t(copy.descriptionKey) }
      }),
    }
  },
  presentAnswer: (question, answer, localization) => {
    if (
      !curationPresentation(question) ||
      !Object.prototype.hasOwnProperty.call(CURATION_OPTIONS, answer)
    )
      return answer
    return localization.t(CURATION_OPTIONS[answer as keyof typeof CURATION_OPTIONS].labelKey, {
      ns: 'literature',
    })
  },
}

const OUTLINE_CONFIRMATION_KIND = 'literature-outline-confirmation'
const OUTLINE_CONFIRMATION_PREFIX = 'outline-review:'
const OUTLINE_CONFIRMATION_LABEL = '按当前方案开始撰写'
const OUTLINE_TIMEOUT_SECONDS = 300
const SECONDS_PER_MINUTE = 60

function outlinePresentation(question: InteractionQuestion) {
  const presentation = question.presentation
  if (
    !question.id?.startsWith(OUTLINE_CONFIRMATION_PREFIX) ||
    presentation?.kind !== OUTLINE_CONFIRMATION_KIND ||
    typeof presentation.format !== 'string' ||
    !presentation.format ||
    typeof presentation.citation_style !== 'string' ||
    !presentation.citation_style ||
    (presentation.timeout_seconds !== null &&
      presentation.timeout_seconds !== OUTLINE_TIMEOUT_SECONDS) ||
    question.multiSelect ||
    question.options.length !== 1 ||
    question.options[0].label !== OUTLINE_CONFIRMATION_LABEL
  )
    return null
  return {
    format: presentation.format,
    citationStyle: presentation.citation_style,
    timeoutSeconds: presentation.timeout_seconds as number | null,
  }
}

export const literatureOutlineConfirmation: InteractionPolicyContribution = {
  id: OUTLINE_CONFIRMATION_KIND,
  title: (localization) => localization.t('outlineConfirmation.title', { ns: 'literature' }),
  matches: (questions) => questions.length === 1 && outlinePresentation(questions[0]) !== null,
  copyQuestion: (question, data, localization) =>
    outlinePresentation(question) && parseReview(data)
      ? literatureCopy('literature.outline', data, localization.getFixedT(null, 'literature'))
      : null,
  presentQuestion: (question, localization) => {
    const presentation = outlinePresentation(question)
    if (!presentation) return question
    const t = localization.getFixedT(null, 'literature')
    return {
      ...question,
      header: t('outlineConfirmation.title'),
      question: [
        t('outlineConfirmation.question'),
        t('outlineConfirmation.settings', {
          format: presentation.format,
          citationStyle: presentation.citationStyle,
        }),
        presentation.timeoutSeconds === null
          ? t('outlineConfirmation.required')
          : t('outlineConfirmation.timeout', {
              count: presentation.timeoutSeconds / SECONDS_PER_MINUTE,
            }),
      ].join('\n\n'),
      options: question.options.map((option) => ({
        ...option,
        label: t('outlineConfirmation.confirm'),
        description: t('outlineConfirmation.description'),
      })),
    }
  },
  presentAnswer: (question, answer, localization) =>
    outlinePresentation(question) && answer === OUTLINE_CONFIRMATION_LABEL
      ? localization.t('outlineConfirmation.confirm', { ns: 'literature' })
      : answer,
}
