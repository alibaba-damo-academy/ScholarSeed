import type { i18n, ParseKeys } from 'i18next'

const FEEDBACK_KEYS = {
  conversation: {
    'request.historyUnavailable': 'none', 'request.timeout': 'none', 'request.unavailable': 'none', 'request.invalidRecovery': 'none',
    'request.failed': 'none', 'request.authentication': 'none', 'request.httpFailure': 'status', 'request.diagnostic': 'detail',
    'request.resourceReviewRequired': 'none',
    'models.deferred': 'none', 'models.effortReset': 'none', 'models.nextTurn': 'none',
    'retry.continueUnconfirmed': 'none', 'retry.continueUnknown': 'none', 'retry.attachmentsGone': 'none', 'retry.contextNotReady': 'none', 'retry.regenerateUnknown': 'none'
  } satisfies Partial<Record<ParseKeys<'conversation'>, 'none' | 'status' | 'detail'>>,
  components: {
    'composer.askPermission': 'none', 'composer.autoPermission': 'none', 'composer.fullPermission': 'none', 'composer.modeSelected': 'mode',
    'composer.terminating': 'none', 'composer.stopFailed': 'error', 'composer.unknownError': 'none',
    'composer.adjustFailed': 'error',
    'composer.attachmentSession': 'none',
    'composer.backendUnavailable': 'none',
    'composer.checkFailed': 'none',
    'composer.confirmContinueFailed': 'none',
    'composer.contextFailed': 'none',
    'composer.contextNotReady': 'none',
    'composer.contextNotSaved': 'none',
    'composer.contextUnavailable': 'name',
    'composer.createFailed': 'none',
    'composer.filesFailed': 'none',
    'composer.messageFailed': 'none',
    'composer.partialFilesFailed': 'none',
    'composer.pendingFailed': 'error',
    'composer.queueCheckUnknown': 'none',
    'composer.queueFailed': 'none',
    'composer.queueRefreshFailed': 'none',
    'composer.queueUnknown': 'none',
    'composer.resendFailed': 'none',
    'composer.runtimePreflight': 'none',
    'composer.runtimeUnavailable': 'none',
    'composer.selectionContextChanged': 'name',
    'composer.sessionUnavailable': 'none',
    'composer.skillDependencies': 'name',
    'composer.skillDisabled': 'name',
    'composer.skillFailed': 'none',
    'composer.skillMissing': 'name',
    'composer.skillPath': 'name',
    'composer.sourceContextChanged': 'name',
    'composer.sourceContextMissing': 'name',
    'composer.stateChanged': 'none',
    'composer.submissionRecovered': 'none',
    'composer.terminated': 'none',
    'composer.withdrawFailed': 'none',
    'composer.withdrawUnavailable': 'none',
    'composer.workspaceFailed': 'none',
    'models.failed': 'none',
    'models.retryFailed': 'none',
    'sessionTitle.failed': 'none',
  } satisfies Partial<Record<ParseKeys<'components'>, 'none' | 'name' | 'error' | 'detail' | 'mode'>>,
  assistant: {
    'sources.untitledSession': 'none',
    'panel.new': 'none',
    'sources.selectionLabel': 'name',
    'sources.resources': 'none', 'sources.resourcesEmpty': 'none', 'sources.literature': 'none',
    'sources.literatureEmpty': 'none', 'sources.sessions': 'none', 'sources.sessionsEmpty': 'none',
    'contextErrors.annotationFailed': 'detail',
    'contextErrors.initializeFailed': 'none',
    'contextErrors.loadFailed': 'none',
    'contextErrors.loading': 'none',
    'contextErrors.newSaveFailed': 'none',
    'contextErrors.projectLoading': 'none',
    'contextErrors.removeFailed': 'detail',
    'contextErrors.saveFailed': 'detail',
    'contextErrors.saveRetry': 'none',
    'contextErrors.sourcePending': 'none',
    'contextErrors.sourceUnavailable': 'none',
    'contextErrors.syncFailed': 'detail',
    'contextErrors.updated': 'none',
    'contextErrors.wrongProject': 'none',
  } satisfies Partial<Record<ParseKeys<'assistant'>, 'none' | 'name' | 'error' | 'detail'>>,
  shell: {
    'foreground.effortFailed': 'none',
    'foreground.permissionConnection': 'none',
    'foreground.permissionFailed': 'none',
    'foreground.permissionImmutable': 'none',
    'foreground.reviewUnknown': 'none',
    'foreground.reviewUnsaved': 'none',
    'foreground.runtimeNotReady': 'none',
    'foreground.submitNotReady': 'none',
    'foreground.workspaceAuthorization': 'none',
  } satisfies Partial<Record<ParseKeys<'shell'>, 'none' | 'name' | 'error' | 'detail'>>,
} as const

type FeedbackNamespace = keyof typeof FEEDBACK_KEYS
type FeedbackKey<N extends FeedbackNamespace> = keyof typeof FEEDBACK_KEYS[N]
type FeedbackValues = Record<string, string | number | FeedbackDescriptor>
export type FeedbackDescriptor = {
  [N in FeedbackNamespace]: { ns: N; key: FeedbackKey<N>; values?: FeedbackValues }
}[FeedbackNamespace]
export type ForegroundMessage = string | FeedbackDescriptor

type ParametersFor<N extends FeedbackNamespace, K extends FeedbackKey<N>> =
  (typeof FEEDBACK_KEYS)[N][K] extends 'none' ? [values?: FeedbackValues]
    : [values: FeedbackValues & Record<Exclude<Extract<(typeof FEEDBACK_KEYS)[N][K], string>, 'none'>, string | number | FeedbackDescriptor>]

export function feedback<N extends FeedbackNamespace, K extends FeedbackKey<N>>(
  ns: N, key: K, ...[values]: ParametersFor<N, K>
): Extract<FeedbackDescriptor, { ns: N }> {
  return { ns, key, values } as Extract<FeedbackDescriptor, { ns: N }>
}

export function renderFeedback(instance: i18n, message: ForegroundMessage): string {
  if (typeof message === 'string') return message
  const value = (key: string): string | number => {
    const input = message.values?.[key]
    return typeof input === 'object' ? renderFeedback(instance, input) : input ?? ''
  }
  const values = { name: value('name'), error: value('error'), detail: value('detail'), status: value('status'), message: value('message'), mode: value('mode') }
  switch (message.ns) {
    case 'components': return instance.getFixedT(null, 'components')(message.key, values) as string
    case 'assistant': return instance.getFixedT(null, 'assistant')(message.key, values) as string
    case 'conversation': return instance.getFixedT(null, 'conversation')(message.key, values) as string
    case 'shell': return instance.getFixedT(null, 'shell')(message.key, values) as string
  }
}
