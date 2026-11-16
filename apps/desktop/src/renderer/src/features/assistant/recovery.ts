import i18next from 'i18next'

import type { InteractionPolicyContribution, InteractionQuestion } from '../../contracts/features'

const SEARCH_RECOVERY_PREFIX = 'search-recovery:'
const SEARCH_RECOVERY_HEADER = 'search_failed'
const RETRY = 'retry_search'
const DISMISS = 'dismiss_search'

const FILE_PREFIX = 'file-recovery:'
const FILE_RETRY = 'retry_file'
const FILE_REMOVE = 'remove_file'

function createFileRecovery(writing: boolean): InteractionPolicyContribution {
  const header = writing ? 'file_write_denied' : 'file_read_failed'
  const cancel = writing ? 'cancel_save' : FILE_REMOVE
  return {
    id: writing ? 'save-recovery' : 'file-recovery',
    get title() {
      return i18next.t('recovery.fileTitle', { ns: 'assistant', path: '' })
    },
    matches: (questions) =>
      questions.length === 1 &&
      Boolean(
        questions[0].id?.startsWith(FILE_PREFIX) &&
        questions[0].header === header &&
        questions[0].options.length === 2 &&
        questions[0].options[0]?.label === FILE_RETRY &&
        questions[0].options[1]?.label === cancel
      ),
    directPresentation: 'high-risk',
    prepareDecision: writing
      ? () => window.scholarseed.openSystemPermission('files-folders')
      : undefined,
    prepareLabel: writing
      ? (localization) => localization.t('recovery.authorize', { ns: 'assistant' })
      : undefined,
    prepareFailure: writing
      ? (localization) => localization.t('recovery.settingsFailed', { ns: 'assistant' })
      : undefined,
    directDecision: () => 'respond',
    presentQuestion: (question, localization) => ({
      ...question,
      header: localization.t(writing ? 'recovery.saveTitle' : 'recovery.fileTitle', {
        ns: 'assistant',
        path: question.question,
      }),
      question: localization.t(writing ? 'recovery.saveDescription' : 'recovery.fileDescription', {
        ns: 'assistant',
      }),
      options: question.options.map((option) => ({
        ...option,
        label: localization.t(
          option.label === FILE_RETRY
            ? 'recovery.retryFile'
            : writing
              ? 'recovery.cancelSave'
              : 'recovery.removeFile',
          { ns: 'assistant' }
        ),
        description: undefined,
      })),
    }),
    presentAnswer: (_question, answer, localization) =>
      localization.t(
        answer === FILE_RETRY
          ? writing
            ? 'recovery.saveRetryRequested'
            : 'recovery.fileRetryRequested'
          : writing
            ? 'recovery.saveCancelled'
            : 'recovery.fileRemoved',
        { ns: 'assistant' }
      ),
    replyTitle: (question, _answer, localization) =>
      localization.t(writing ? 'recovery.saveTitle' : 'recovery.fileTitle', {
        ns: 'assistant',
        path: question.question,
      }),
    replyText: (_question, answer, localization) =>
      localization.t(
        answer === FILE_RETRY
          ? writing
            ? 'recovery.saveRetryRequested'
            : 'recovery.fileRetryRequested'
          : writing
            ? 'recovery.saveCancelled'
            : 'recovery.fileRemoved',
        { ns: 'assistant' }
      ),
  }
}

export const fileRecovery = createFileRecovery(false)
export const saveRecovery = createFileRecovery(true)

const EXTERNAL_READ_PREFIX = 'external-read:'
const EXTERNAL_READ_HEADER = 'external_file_read'
const ALLOW_FILE_READ = 'allow_file_read'
const DENY_FILE_READ = 'deny_file_read'

export const externalReadAuthorization: InteractionPolicyContribution = {
  id: 'external-read-authorization',
  get title() {
    return i18next.t('externalRead.title', { ns: 'assistant' })
  },
  matches: (questions) =>
    questions.length === 1 &&
    Boolean(
      questions[0].id?.startsWith(EXTERNAL_READ_PREFIX) &&
      questions[0].header === EXTERNAL_READ_HEADER &&
      questions[0].options.length === 2 &&
      questions[0].options[0]?.label === ALLOW_FILE_READ &&
      questions[0].options[1]?.label === DENY_FILE_READ
    ),
  directPresentation: 'high-risk',
  directDecision: () => 'respond',
  presentQuestion: (question, localization) => ({
    ...question,
    header: localization.t('externalRead.title', { ns: 'assistant' }),
    question: localization.t('externalRead.description', {
      ns: 'assistant',
      path: question.question,
    }),
    options: question.options.map((option) => ({
      ...option,
      label: localization.t(
        option.label === ALLOW_FILE_READ ? 'externalRead.allow' : 'externalRead.deny',
        { ns: 'assistant' }
      ),
      description: undefined,
    })),
  }),
  presentAnswer: (_question, answer, localization) =>
    localization.t(answer === ALLOW_FILE_READ ? 'externalRead.allowed' : 'externalRead.denied', {
      ns: 'assistant',
    }),
  replyTitle: (question) => question.question,
  replyText: (_question, answer, localization) =>
    localization.t(answer === ALLOW_FILE_READ ? 'externalRead.allowed' : 'externalRead.denied', {
      ns: 'assistant',
    }),
}

function isSearchRecovery(question: InteractionQuestion): boolean {
  return Boolean(
    question.id?.startsWith(SEARCH_RECOVERY_PREFIX) &&
    question.header === SEARCH_RECOVERY_HEADER &&
    question.options.length === 2 &&
    question.options[0]?.label === RETRY &&
    question.options[1]?.label === DISMISS
  )
}

export const searchRecovery: InteractionPolicyContribution = {
  id: 'search-recovery',
  get title() {
    return i18next.t('recovery.searchTitle', { ns: 'assistant' })
  },
  matches: (questions) => questions.length === 1 && isSearchRecovery(questions[0]),
  directDecision: () => 'respond',
  directPresentation: 'failure-strip',
  presentQuestion: (question, localization) => ({
    ...question,
    header: localization.t('recovery.searchTitle', { ns: 'assistant' }),
    question: localization.t('recovery.searchDescription', {
      ns: 'assistant',
      query: question.question,
      reason: question.options[0]?.description ?? '',
    }),
    options: question.options.map((option) => ({
      ...option,
      label: localization.t(option.label === RETRY ? 'recovery.retrySearch' : 'recovery.dismiss', {
        ns: 'assistant',
      }),
      description: undefined,
    })),
  }),
  presentAnswer: (_question, answer, localization) =>
    localization.t(answer === RETRY ? 'recovery.retryRequested' : 'recovery.dismissed', {
      ns: 'assistant',
    }),
}
