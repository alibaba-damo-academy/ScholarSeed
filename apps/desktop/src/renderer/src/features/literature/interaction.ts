import i18next, { type i18n } from 'i18next'

import type { InteractionPolicyContribution, InteractionQuestion } from '../../contracts/features'

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
  { prefix: 'precise-search-fulltext:', header: 'review.authorization.preciseHeader', question: 'review.authorization.preciseQuestion' },
  { prefix: 'literature-review-fulltext:', header: 'review.authorization.reviewHeader', question: 'review.authorization.reviewQuestion' },
  { prefix: 'research-idea-fulltext:', header: 'review.authorization.ideaHeader', question: 'review.authorization.ideaQuestion' }
] as const
const AUTHORIZATION_OPTIONS = {
  [AUTHORIZE]: { labelKey: 'review.authorization.authorize', descriptionKey: 'review.authorization.authorizeDescription' },
  [REJECT]: { labelKey: 'review.authorization.reject', descriptionKey: 'review.authorization.rejectDescription' }
} as const

function authorizationCopy(question: InteractionQuestion) {
  return AUTHORIZATION_COPY.find(copy => question.id?.startsWith(copy.prefix))
}

function presentAuthorizationQuestion(question: InteractionQuestion, localization: i18n): InteractionQuestion {
  const copy = authorizationCopy(question)
  if (!copy) return question
  return {
    ...question,
    header: localization.t(copy.header, { ns: 'literature' }),
    question: localization.t(copy.question, { ns: 'literature' }),
    options: question.options.map(option => {
      const label = authorizationLabel(option.label)
      if (label !== AUTHORIZE && label !== REJECT) return option
      const optionCopy = AUTHORIZATION_OPTIONS[label]
      return {
        ...option,
        label: localization.t(optionCopy.labelKey, { ns: 'literature' }),
        description: localization.t(optionCopy.descriptionKey, { ns: 'literature' })
      }
    })
  }
}

function presentAuthorizationAnswer(question: InteractionQuestion, answer: string, localization: i18n): string {
  if (!authorizationCopy(question) || (answer !== AUTHORIZE && answer !== REJECT)) return answer
  return localization.t(AUTHORIZATION_OPTIONS[answer].labelKey, { ns: 'literature' })
}

function authorizationLabel(label: string): string {
  return label.replace(RECOMMENDED_SUFFIX, '')
}

function labels(question: InteractionQuestion): string[] {
  return question.options.map(option => option.label)
}

function includes(question: InteractionQuestion, pattern: RegExp): boolean {
  return labels(question).some(label => pattern.test(label))
}

function isPrimary(questions: readonly InteractionQuestion[]): boolean {
  return questions.some(question => question.header === OUTPUT_HEADER && includes(question, PDF) && includes(question, MARKDOWN))
    && questions.some(question => question.header === CITATION_HEADER && includes(question, NUMERIC) && includes(question, AUTHOR_YEAR) && includes(question, PUBLISHER))
}

function isPublisherFollowup(questions: readonly InteractionQuestion[]): boolean {
  return questions.length === 1 && questions[0].header === PUBLISHER_HEADER
    && includes(questions[0], IEEE) && includes(questions[0], ACM)
}

function isRetrievalAuthorization(questions: readonly InteractionQuestion[]): boolean {
  const optionLabels = questions[0]?.options.map(option => authorizationLabel(option.label)) ?? []
  return questions.length === 1
    && AUTHORIZATION_HEADERS.has(questions[0].header ?? '')
    && optionLabels.length === 2
    && optionLabels.includes(AUTHORIZE)
    && optionLabels.includes(REJECT)
}

function defaultFor(question: InteractionQuestion): string {
  const option = question.options.find(candidate => MARKDOWN.test(candidate.label))
    ?? question.options.find(candidate => NUMERIC.test(candidate.label))
  return option?.label ?? i18next.t('review.interactionDefault', { ns: 'literature' })
}

export const literatureReviewInteraction = {
  id: 'slr-output-spec',
  get title() { return i18next.t('review.interactionTitle', { ns: 'literature' }) },
  matches: questions => isPrimary(questions) || isPublisherFollowup(questions),
  complete: (questions, answers, texts) => questions.every((question, index) => question.options.length
    ? (answers[index]?.length ?? 0) > 0
    : Boolean(texts[index]?.trim())),
  defaults: questions => Object.fromEntries(questions.map(question => [
    question.id || question.header || question.question,
    isPublisherFollowup(questions) ? i18next.t('review.interactionDefault', { ns: 'literature' }) : defaultFor(question)
  ])),
  get defaultLabel() { return i18next.t('review.interactionDefaultLabel', { ns: 'literature' }) }
} satisfies InteractionPolicyContribution

function authorizationPolicy(
  id: string,
  matches: (questions: readonly InteractionQuestion[]) => boolean
): InteractionPolicyContribution {
  return {
    id,
    get title() { return i18next.t('review.authorizationTitle', { ns: 'literature' }) },
    matches,
    directDecision: () => 'respond',
    directPresentation: 'primary-secondary',
    directSelectionRequired: option => authorizationLabel(option.label) === AUTHORIZE,
    optionLabel: option => authorizationLabel(option.label),
    replyTitle: (_question, answer, localization) =>
      authorizationLabel(answer) === AUTHORIZE
        ? localization.t('review.authorizationReplyTitle', { ns: 'literature' })
        : undefined,
    replyText: (_question, answer, localization) => {
      const label = authorizationLabel(answer)
      if (label === AUTHORIZE) return localization.t('review.authorizationReplyGranted', { ns: 'literature' })
      if (label === REJECT) return localization.t('review.authorizationReplyRejected', { ns: 'literature' })
      return undefined
    },
    presentQuestion: presentAuthorizationQuestion,
    presentAnswer: presentAuthorizationAnswer,
    get cancelledLabel() {
      return (question: InteractionQuestion) => i18next.t('review.authorizationRejected', { ns: 'literature' })
        || question.options.find(option => authorizationLabel(option.label) === REJECT)?.description
        || REJECT
    }
  }
}

const PRECISE_FULLTEXT_PREFIX = 'precise-search-fulltext:'

/** 精准检索的合并授权卡：单一问题携带论文子集清单，子集经决策值回传、不落账。 */
function isPreciseSubsetAuthorization(questions: readonly InteractionQuestion[]): boolean {
  const question = questions[0]
  return questions.length === 1
    && (question?.id?.startsWith(PRECISE_FULLTEXT_PREFIX) ?? false)
    && (question?.papers?.length ?? 0) > 0
    && isRetrievalAuthorization(questions)
}

export const preciseFulltextSubsetAuthorization = authorizationPolicy(
  'precise-fulltext-subset-authorization',
  isPreciseSubsetAuthorization
)

export const literatureRetrievalAuthorization = authorizationPolicy(
  'literature-corpus-authorization',
  isRetrievalAuthorization
)
