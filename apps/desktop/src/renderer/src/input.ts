import { requestFailureFeedback } from './api.ts'
import { formatApplicationRequestFailure } from './runtime.ts'
import { referenceLabel } from './features/assistant/text.ts'
import { contextLabelFallback, type ContextLabelFallback } from './contracts/assistant.ts'
import { feedback, turnAdmissionMessageKey, type FeedbackDescriptor } from './contracts/feedback.ts'
import type { TFunction } from 'i18next'

import type {
  AssistantContextFailureIssue,
  BackendFailureDetail,
  TurnInputItem,
  TurnResponse,
} from './api'
import type { ComposerReference, SessionSurface } from './store'
import type { MainView } from '../../navigation'
import type { AssistantContextRef } from './contracts/assistant'

const WINDOWS_ABSOLUTE_PATH = /^(?:\\\\\?\\)?[A-Za-z]:[\\/]/
const WINDOWS_UNC_ABSOLUTE_PATH = /^\\\\(?:\?\\UNC\\)?(?!\.{1,2}\\)[^\\/?]+\\[^\\/?]+(?:\\|$)/i
export const COMPOSER_SKILL_KIND = 'skill'
const ASSISTANT_CONTEXT_UNAVAILABLE = 'assistant_context_unavailable'
const RESOURCE_REVIEW_REQUIRED = 'resource_review_required'
const SOURCE_REVISION_CHANGED = 'source_revision_changed'
const SELECTION_TEXT_CHANGED = 'selection_text_changed'
const SELECTION_SNAPSHOT_REQUIRED = 'selection_snapshot_required'
const SOURCE_MISSING = 'source_missing'
const COMPOSER_TRIGGERS = [
  { pattern: /(^|\s)@([^\s@]{0,40})$/, prefix: '' },
  { pattern: /(^|\s)\/([^\s/@:]*)$/, prefix: `${COMPOSER_SKILL_KIND}:` },
]

/** Both shortcuts use the same candidate picker and typed reference flow. */
export function composerTrigger(
  text: string,
  caret = text.length
): { query: string; start: number } | null {
  for (const { pattern, prefix } of COMPOSER_TRIGGERS) {
    const match = pattern.exec(text.slice(0, caret))
    if (match) return { query: `${prefix}${match[2]}`, start: match.index + match[1].length }
  }
  return null
}

export function replaceComposerTrigger(
  text: string,
  replacement: string,
  caret = text.length
): string {
  const trigger = composerTrigger(text, caret)
  return trigger ? `${text.slice(0, trigger.start)}${replacement}${text.slice(caret)}` : text
}

/** Workbench documents obscure the legacy conversation, not its adjacent AI panel. */
export function composerObscured(
  surface: SessionSurface,
  overlays: { capabilities: boolean; files: boolean; documents: boolean }
): boolean {
  return surface === 'conversation' && Object.values(overlays).some(Boolean)
}

export function canConsumeDraftSubmission(state: {
  surface: SessionSurface
  view: MainView
  ready: boolean
  consumed: boolean
  obscured: boolean
}): boolean {
  return (
    state.surface === 'assistant' &&
    state.view === 'resource' &&
    state.ready &&
    !state.consumed &&
    !state.obscured
  )
}

export function composerHasContent(
  message: string,
  references: readonly ComposerReference[],
  contextRefs: readonly AssistantContextRef[]
): boolean {
  return (
    Boolean(message.trim()) ||
    references.length > 0 ||
    contextRefs.some((reference) => reference.origin === 'explicit')
  )
}

export type ComposerSubmissionState = {
  runtimeReady: boolean
  creditsAvailable: boolean
  modelAvailable: boolean
  launching: boolean
  running: boolean
  interrupting: boolean
  hasContent: boolean
}

/**
 * A running session accepts the draft into the durable product queue. Interrupt
 * remains a short admission barrier because the active turn identity is changing.
 * A catalogue with nothing selectable admits nothing either: with no usable model
 * the draft can only fail at the execution gate, so the send stays disabled.
 */
export function canSubmitComposer(state: ComposerSubmissionState): boolean {
  return (
    state.runtimeReady &&
    state.creditsAvailable &&
    state.modelAvailable &&
    !state.launching &&
    !state.interrupting &&
    state.hasContent
  )
}

/** The server may finish the active turn before a queue-intended request arrives. */
export function isComposerSubmissionAccepted(response: TurnResponse | null): boolean {
  return (
    response?.ok === true &&
    response.accepted === true &&
    !response.error &&
    Boolean(response.turn_id || response.queued_message_id)
  )
}

export function composerSubmissionOutcome(
  response: TurnResponse | null
): 'accepted' | 'rejected' | 'unknown' {
  if (isComposerSubmissionAccepted(response)) return 'accepted'
  return response?.submissionOutcome === 'rejected' ? 'rejected' : 'unknown'
}

type TurnAdmissionFailure = {
  applicationFailure?: TurnResponse['applicationFailure']
  error?: TurnResponse['error']
  code?: BackendFailureDetail['code']
  message?: BackendFailureDetail['message']
  issues?: AssistantContextFailureIssue[]
}

type TurnAdmissionFeedback =
  | Extract<FeedbackDescriptor, { ns: 'components' }>
  | ReturnType<typeof resourceReviewRequiredFeedback>

function resourceReviewRequiredFeedback() {
  return feedback('conversation', 'request.resourceReviewRequired')
}

function firstContextIssue(
  failure: TurnAdmissionFailure
): AssistantContextFailureIssue | undefined {
  return failure.issues?.[0]
}

/** Convert stable Assistant admission codes into an actionable, localized message. */
export function describeTurnAdmissionFailure(
  t: TFunction<'components'>,
  failure: TurnAdmissionFailure
): string {
  if (failure.applicationFailure)
    return formatApplicationRequestFailure(failure.applicationFailure, (key, values) =>
      t(key, { ...values, ns: 'conversation' })
    )
  const message = contextAdmissionFeedback(failure)
  const name = message.values?.name
  const label =
    typeof name === 'object' && name.ns === 'assistant'
      ? name.key === 'sources.untitledSession'
        ? t('sources.untitledSession', { ns: 'assistant' })
        : name.key === 'panel.new'
          ? t('panel.new', { ns: 'assistant' })
          : name.key === 'sources.selectionLabel'
            ? t('sources.selectionLabel', {
                ns: 'assistant',
                name: String(name.values?.name ?? ''),
              })
            : String(name)
      : String(name ?? '')
  const values = { name: label, error: '', detail: '', status: 0, message: '', mode: '' }
  return message.ns === 'conversation'
    ? t(message.key, { ...values, ns: 'conversation' })
    : t(message.key, values)
}

export function turnAdmissionFeedback(failure: TurnAdmissionFailure): TurnAdmissionFeedback {
  return failure.applicationFailure
    ? requestFailureFeedback(failure.applicationFailure)
    : contextAdmissionFeedback(failure)
}

function contextAdmissionFeedback(failure: TurnAdmissionFailure): TurnAdmissionFeedback {
  const code = failure.code ?? failure.error
  if (code === RESOURCE_REVIEW_REQUIRED) {
    return resourceReviewRequiredFeedback()
  }
  const admissionKey = turnAdmissionMessageKey(code)
  if (admissionKey) {
    return feedback('components', admissionKey)
  }
  const issue = firstContextIssue(failure)
  if (code === ASSISTANT_CONTEXT_UNAVAILABLE && issue) {
    const fallback = contextLabelFallback(issue.kind, issue.label_fallback)
    const name =
      fallback === 'new_session'
        ? feedback('assistant', 'panel.new')
        : fallback === 'untitled_session'
          ? feedback('assistant', 'sources.untitledSession')
          : (issue.kind === 'selection' || issue.kind === 'literature') &&
              typeof issue.selection_source_label === 'string'
            ? feedback('assistant', 'sources.selectionLabel', {
                name: issue.selection_source_label,
              })
            : issue.label || issue.kind
    if (issue.reason === SELECTION_TEXT_CHANGED) {
      return feedback('components', 'composer.selectionContextChanged', { name })
    }
    if (issue.reason === SELECTION_SNAPSHOT_REQUIRED) {
      return feedback('components', 'composer.selectionSnapshotRequired', { name })
    }
    if (issue.reason === SOURCE_REVISION_CHANGED) {
      return feedback('components', 'composer.sourceContextChanged', { name })
    }
    if (issue.reason === SOURCE_MISSING) {
      return feedback('components', 'composer.sourceContextMissing', { name })
    }
    return feedback('components', 'composer.contextUnavailable', { name })
  }
  return feedback('components', 'composer.messageFailed')
}

export function isAbsoluteInputPath(path: string | undefined): path is string {
  return Boolean(
    path &&
    (path.startsWith('/') ||
      WINDOWS_ABSOLUTE_PATH.test(path) ||
      WINDOWS_UNC_ABSOLUTE_PATH.test(path))
  )
}

type QueuedReference = {
  title?: string
  label?: string
  kind?: string
  state?: string
  selection_source_label?: string | null
  anchor?: unknown
  label_fallback?: ContextLabelFallback
}

const QUEUED_REFERENCE_KIND_KEYS = {
  file: 'queue.kinds.file',
  dir: 'queue.kinds.dir',
  resource: 'queue.kinds.resource',
  literature: 'queue.kinds.literature',
  literature_collection: 'queue.kinds.literatureCollection',
  session: 'queue.kinds.session',
  selection: 'queue.kinds.selection',
  note: 'queue.kinds.note',
} as const
const QUEUED_REFERENCE_STATE_KEYS = {
  ready: 'queue.states.ready',
  truncated: 'queue.states.truncated',
  stale: 'queue.states.stale',
  missing: 'queue.states.missing',
  forbidden: 'queue.states.forbidden',
  unsupported: 'queue.states.unsupported',
  unavailable: 'queue.states.unavailable',
  too_large: 'queue.states.tooLarge',
} as const

function queuedReferenceTitle(reference: QueuedReference, t: TFunction<'assistant'>): string {
  if (
    contextLabelFallback(reference.kind, reference.label_fallback) ||
    ((reference.kind === 'selection' || reference.kind === 'literature') &&
      reference.anchor &&
      typeof reference.selection_source_label === 'string')
  )
    return referenceLabel(reference, t)
  if (reference.title || reference.label) return reference.title || reference.label!
  const kind = reference.kind
  if (!kind) return t('queue.context')
  return Object.prototype.hasOwnProperty.call(QUEUED_REFERENCE_KIND_KEYS, kind)
    ? t(QUEUED_REFERENCE_KIND_KEYS[kind as keyof typeof QUEUED_REFERENCE_KIND_KEYS])
    : kind
}

export function queuedReferenceLabel(
  reference: QueuedReference,
  t: TFunction<'assistant'>
): string {
  const title = queuedReferenceTitle(reference, t)
  const state = reference.state
  if (!state || state === 'ready') return title
  const label = Object.prototype.hasOwnProperty.call(QUEUED_REFERENCE_STATE_KEYS, state)
    ? t(QUEUED_REFERENCE_STATE_KEYS[state as keyof typeof QUEUED_REFERENCE_STATE_KEYS])
    : state
  return t('queue.referenceState', { title, state: label })
}

export function queuedReferenceSummary(
  input: TurnInputItem[],
  assistantReferences: QueuedReference[],
  t: TFunction<'assistant'>
): string {
  const typedLabels = input.flatMap((item) => {
    if (item.type === 'text') return []
    if (item.type === 'skill') return [item.name || t('queue.skill')]
    return [
      item.name ||
        (item.type === 'local_image'
          ? t('queue.image')
          : item.type === 'directory'
            ? t('queue.kinds.dir')
            : t('queue.kinds.file')),
    ]
  })
  const assistantLabels = assistantReferences.map((reference) => queuedReferenceTitle(reference, t))
  return [...typedLabels, ...assistantLabels].join(t('queue.separator'))
}

/** Build the one typed turn-input contract used by visible sends and desktop harness sends. */
export function buildTurnInput(message: string, references: ComposerReference[]): TurnInputItem[] {
  const skills = references.filter((reference) => reference.type === 'skill')
  const files = references.filter(
    (reference): reference is Extract<ComposerReference, { type: 'file' | 'directory' }> =>
      reference.type === 'file' || reference.type === 'directory'
  )
  const invalid = references.find((reference) =>
    reference.type === 'directory' && !reference.referenceId
      ? true
      : (reference.type === 'file' || reference.type === 'directory') && reference.referenceId
        ? false
        : !isAbsoluteInputPath(reference.path)
  )
  if (invalid)
    throw new Error(`${invalid.type} reference has no canonical absolute path: ${invalid.id}`)

  // Skill identity belongs to the typed item below. Duplicating it into text leaks
  // runtime syntax into user history and lets `$skill-name` become the session title.
  const text = message.trim()
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...skills.map((reference): TurnInputItem => ({
      type: 'skill',
      name: reference.id,
      path: reference.path,
      version: reference.version,
    })),
    ...files.map((reference): TurnInputItem =>
      reference.type === 'directory'
        ? {
            type: 'directory',
            reference_id: reference.referenceId || '',
            name: reference.title,
          }
        : {
            type: reference.mediaType?.startsWith('image/') ? 'local_image' : 'file',
            ...(reference.referenceId
              ? { reference_id: reference.referenceId }
              : { path: reference.path }),
            name: reference.title,
            media_type: reference.mediaType,
            sha256: reference.sha256,
          }
    ),
  ]
}
