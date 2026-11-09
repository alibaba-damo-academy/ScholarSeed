import {
  DEFAULT_RENDERER_PREFERENCES,
  rendererPreferencesEqual,
  type RendererPreferences,
} from './preferences.ts'

export const PREFERENCE_DIAGNOSTIC_PREFIX = '[preferences]'
export const PREFERENCE_FIELDS = [
  ...Object.keys(DEFAULT_RENDERER_PREFERENCES),
  'onboarding',
  'reasoningPreferences',
  'languageMode',
] as (keyof RendererPreferences)[]
export const PREFERENCE_SUBMISSION_SOURCE = {
  explicit: 'explicit',
  automatic: 'state-effect',
  language: 'language',
  prompts: 'selection-prompts',
  models: 'literature-models',
  onboarding: 'onboarding',
  navigation: 'navigation',
  retry: 'retry',
  shutdown: 'shutdown',
} as const
export type PreferenceSubmissionSource =
  (typeof PREFERENCE_SUBMISSION_SOURCE)[keyof typeof PREFERENCE_SUBMISSION_SOURCE]
export interface PreferenceSubmission {
  writerId: string
  submissionSources: PreferenceSubmissionSource[]
  changedFields: (keyof RendererPreferences)[]
  submittedRevision: number
}
export interface PreferenceReceipt {
  preferences: RendererPreferences
  acknowledgedRevision: number
}

export function preferenceChanges(
  before: RendererPreferences,
  after: RendererPreferences
): (keyof RendererPreferences)[] {
  return PREFERENCE_FIELDS.filter(
    (key) => !rendererPreferencesEqual(before, { ...before, [key]: after[key] })
  )
}

export function parsePreferenceSubmission(value: unknown): PreferenceSubmission | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid preference submission')
  const record = value as PreferenceSubmission
  if (
    typeof record.writerId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(record.writerId) ||
    !Number.isSafeInteger(record.submittedRevision) ||
    record.submittedRevision <= 0 ||
    !Array.isArray(record.submissionSources) ||
    !record.submissionSources.length ||
    record.submissionSources.length > Object.keys(PREFERENCE_SUBMISSION_SOURCE).length ||
    !record.submissionSources.every((source) =>
      Object.values(PREFERENCE_SUBMISSION_SOURCE).includes(source)
    ) ||
    !Array.isArray(record.changedFields) ||
    record.changedFields.length > PREFERENCE_FIELDS.length ||
    !record.changedFields.every((key) => PREFERENCE_FIELDS.includes(key))
  )
    throw new Error('Invalid preference submission')
  return {
    writerId: record.writerId,
    submissionSources: [...record.submissionSources],
    changedFields: [...record.changedFields],
    submittedRevision: record.submittedRevision,
  }
}

export type PreferenceStage =
  | 'ipc-save'
  | 'ipc-reconcile'
  | 'save'
  | 'apply'
  | 'reconcile'
  | 'reconcile-apply'
  | 'read'
  | 'validate'
  | 'acquire'
  | 'write'
  | 'release'
  | 'main-apply'
  | 'submit'
  | 'freeze'
  | 'flush'
  | 'write-detail'
  | 'failure-notification-request'
  | 'retry-request'

interface PreferenceRuntime {
  platform: string
  arch: string
  pid: number
  node: string
  electron?: string
  uv: string
}

interface PreferenceWriteEvent {
  operation: string
  result: 'failed' | 'completed'
  elapsedMs: number
  published: boolean
  error?: unknown
}

interface PreferenceDiagnosticDetails {
  operation?: string
  elapsedMs?: number
  published?: boolean
  runtime?: PreferenceRuntime
}

export type PreferenceDiagnosticSink = (line: string) => void

const ERROR_DEPTH_LIMIT = 3
const ERROR_CAUSE_LIMIT = 3
const ERROR_FRAME_LIMIT = 8
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'AggregateError',
  'ReferenceError',
])
const ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOENT',
  'ENOSPC',
  'EIO',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EINVAL',
  'ENAMETOOLONG',
  'ERR_WORKBENCH_NOT_READY',
  'ERR_PREFERENCES_UNSAVED',
  'ERR_PREFERENCES_FROZEN',
  'ERR_PREFERENCES_TIMEOUT',
  'ERR_PREFERENCES_RECEIPT',
  'ERR_DOMAIN_CHANGED',
  'ERR_DOMAIN_RELEASE',
  'ERR_LEASE_BUSY',
  'ERR_LEASE_MISSING',
  'ERR_LEASE_RELEASE',
  'ERR_LEASE_ALLOCATION',
  'ERR_LEASE_ARGUMENT',
  'ERR_LEASE_CLOSED',
  'ERR_LEASE_FILE',
  'ERR_LEASE_IN_USE',
  'ERR_LEASE_NATIVE',
])
const ERROR_SYSCALLS = new Set([
  'open',
  'read',
  'write',
  'rename',
  'mkdir',
  'close',
  'fsync',
  'stat',
  'fstat',
  'unlink',
])
let attemptSequence = 0

function errorMetadata(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== 'object' || depth >= ERROR_DEPTH_LIMIT) return { name: 'Unknown' }
  const source = error as Record<string, unknown>
  const name =
    typeof source.name === 'string' && ERROR_NAMES.has(source.name) ? source.name : 'Unknown'
  const code =
    typeof source.code === 'string' && ERROR_CODES.has(source.code)
      ? source.code
      : typeof source.message === 'string' && ERROR_CODES.has(source.message)
        ? source.message
        : undefined
  const frames =
    typeof source.stack === 'string'
      ? source.stack
          .split('\n')
          .slice(1, ERROR_FRAME_LIMIT + 1)
          .flatMap((frame) => {
            const location = /:(\d+):(\d+)\)?$/.exec(frame)
            return location ? [{ line: Number(location[1]), column: Number(location[2]) }] : []
          })
      : []
  const causes = Array.isArray(source.errors)
    ? source.errors.slice(0, ERROR_CAUSE_LIMIT)
    : source.cause
      ? [source.cause]
      : []
  return {
    name,
    code,
    errno:
      typeof source.errno === 'number' && Number.isSafeInteger(source.errno)
        ? source.errno
        : undefined,
    systemCode:
      typeof source.systemCode === 'number' && Number.isSafeInteger(source.systemCode)
        ? source.systemCode
        : undefined,
    syscall:
      typeof source.syscall === 'string' && ERROR_SYSCALLS.has(source.syscall)
        ? source.syscall
        : undefined,
    frames,
    ...(causes.length ? { causes: causes.map((cause) => errorMetadata(cause, depth + 1)) } : {}),
  }
}

export class PreferenceDiagnostics {
  private readonly attempt = ++attemptSequence
  constructor(
    private readonly source: 'main' | 'renderer',
    private readonly sink?: PreferenceDiagnosticSink,
    private readonly submission?: PreferenceSubmission,
    private acknowledgedRevision = 0
  ) {}

  acknowledge(revision: number): void {
    this.acknowledgedRevision = revision
  }

  private emit(
    stage: PreferenceStage,
    result: 'failed' | 'completed',
    error?: unknown,
    details?: PreferenceDiagnosticDetails
  ): void {
    if (!this.sink) return
    try {
      this.sink(
        `${PREFERENCE_DIAGNOSTIC_PREFIX} ${JSON.stringify({
          timestamp: new Date().toISOString(),
          source: this.source,
          attempt: this.attempt,
          stage,
          result,
          ...this.submission,
          acknowledgedRevision: this.acknowledgedRevision,
          ...details,
          ...(result === 'failed' ? { error: errorMetadata(error) } : {}),
        })}`
      )
    } catch {
      return
    }
  }

  completed(stage: PreferenceStage): void {
    this.emit(stage, 'completed')
  }

  recordWrite(event: PreferenceWriteEvent, runtime: PreferenceRuntime): void {
    this.emit('write-detail', event.result, event.error, {
      operation: event.operation,
      elapsedMs: event.elapsedMs,
      published: event.published,
      runtime: {
        platform: runtime.platform,
        arch: runtime.arch,
        pid: runtime.pid,
        node: runtime.node,
        electron: runtime.electron,
        uv: runtime.uv,
      },
    })
  }

  runSync<Value>(stage: PreferenceStage, operation: () => Value): Value {
    try {
      return operation()
    } catch (error) {
      this.emit(stage, 'failed', error)
      throw error
    }
  }

  async run<Value>(stage: PreferenceStage, operation: () => Promise<Value>): Promise<Value> {
    try {
      return await operation()
    } catch (error) {
      this.emit(stage, 'failed', error)
      throw error
    }
  }
}
