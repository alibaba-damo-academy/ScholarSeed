import i18next, { type i18n } from 'i18next'

import type { InteractionPolicyContribution, InteractionQuestion } from '../../contracts/features'
import { literatureCopy } from './copy.ts'
import { parseReview } from './projection.ts'

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
const AUTHORIZATION_HEADERS = new Set(['综述检索授权', '精准检索授权', '想法原文授权'])
const AUTHORIZE = '一键授权'
const REJECT = '拒绝'
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i
const AUTHORIZATION_COPY = [
  {
    prefix: 'precise-search-fulltext:',
    header: 'review.authorization.preciseHeader',
    question: 'review.authorization.preciseQuestion',
  },
  {
    prefix: 'literature-review-fulltext:',
    header: 'review.authorization.reviewHeader',
    question: 'review.authorization.reviewQuestion',
  },
  {
    prefix: 'research-idea-fulltext:',
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

function presentAuthorizationQuestion(
  question: InteractionQuestion,
  localization: i18n
): InteractionQuestion {
  const copy = authorizationCopy(question)
  if (!copy) return question
  return {
    ...question,
    header: localization.t(copy.header, { ns: 'literature' }),
    question: localization.t(copy.question, { ns: 'literature' }),
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
    questions.every((question, index) =>
      question.options.length ? (answers[index]?.length ?? 0) > 0 : Boolean(texts[index]?.trim())
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
      return (question: InteractionQuestion) =>
        i18next.t('review.authorizationRejected', { ns: 'literature' }) ||
        question.options.find((option) => authorizationLabel(option.label) === REJECT)
          ?.description ||
        REJECT
    },
  }
}

const PRECISE_FULLTEXT_PREFIX = 'precise-search-fulltext:'

/** 精准检索的合并授权卡：单一问题携带论文子集清单，子集经决策值回传、不落账。 */
function isPreciseSubsetAuthorization(questions: readonly InteractionQuestion[]): boolean {
  const question = questions[0]
  return (
    questions.length === 1 &&
    (question?.id?.startsWith(PRECISE_FULLTEXT_PREFIX) ?? false) &&
    (question?.papers?.length ?? 0) > 0 &&
    isRetrievalAuthorization(questions)
  )
}

export const preciseFulltextSubsetAuthorization = authorizationPolicy(
  'precise-fulltext-subset-authorization',
  isPreciseSubsetAuthorization
)

export const literatureRetrievalAuthorization = authorizationPolicy(
  'literature-corpus-authorization',
  isRetrievalAuthorization
)

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
