export const RECORDER_ROOT_ATTRIBUTE = 'data-feedback-recorder-root'
export const RECORDER_MAX_STEPS = 500
export const RECORDER_MAX_REQUESTS = 300
export const RECORDER_BODY_MAX_LENGTH = 64 * 1024
export const RECORDER_NOTE_MAX_LENGTH = 1000
export const RECORDER_REPORT_MAX_BYTES = 2 * 1024 * 1024
export const RECORDER_DESCRIPTION_MAX_LENGTH = 5000
export const RECORDER_SCHEMA_VERSION = 1 as const

export type RecorderPhase =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'annotating'
  | 'review'
  | 'submitting'
  | 'done'

export type StepKind = 'click' | 'input' | 'change' | 'navigation'

export interface PageContext {
  url: string
  title: string
  path?: string
  label?: string
  dialogLabel?: string
}

export type TargetLocatorKind =
  | 'testId'
  | 'ariaLabel'
  | 'roleName'
  | 'id'
  | 'name'
  | 'href'
  | 'text'
  | 'tag'

export interface TargetLocator {
  kind: TargetLocatorKind
  value: string
}

export interface ElementBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface TargetSummary {
  tag: string
  testId?: string
  role?: string
  ariaLabel?: string
  accessibleName?: string
  text?: string
  id?: string
  name?: string
  href?: string
  locator?: TargetLocator
  containerTestIds?: readonly string[]
  bounds?: ElementBounds
}

export interface PointerPosition {
  x: number
  y: number
}

export interface RecordedStep {
  stepId: string
  occurredAt: string
  elapsedMs: number
  kind: StepKind
  page: PageContext
  target: TargetSummary
  value?: string
  pointer?: PointerPosition
}

export interface NetworkRecord {
  requestId: string
  startedAt: string
  endedAt: string
  durationMs: number
  method: string
  url: string
  status?: number
  requestBody?: string
  responseBody?: string
  error?: string
  stepId?: string
}

export interface StepNote {
  stepId: string
  text: string
}

export interface AnnotationPoint {
  x: number
  y: number
}

export type Annotation =
  | { type: 'rect'; color: string; x: number; y: number; width: number; height: number }
  | { type: 'arrow'; color: string; points: [AnnotationPoint, AnnotationPoint] }
  | { type: 'pen'; color: string; points: AnnotationPoint[] }
  | { type: 'text'; color: string; x: number; y: number; text: string }

export interface RecordedScreenshot {
  screenshotId: string
  stepId?: string
  note: string
  file: File
  previewUrl: string
  annotations: Annotation[]
}

export interface SummaryFields {
  generated: string
  final: string
  actual: string
  expected: string
  additional: string
}

export interface RecordingReport {
  schemaVersion: typeof RECORDER_SCHEMA_VERSION
  session: {
    sessionId: string
    startedAt: string
    endedAt: string
    initialPage: string
    finalPage: string
    status: 'completed'
  }
  steps: readonly RecordedStep[]
  stepNotes: readonly StepNote[]
  requests: readonly NetworkRecord[]
  screenshots: readonly {
    screenshotId: string
    stepId?: string
    note: string
    filename: string
  }[]
  summary: SummaryFields
  truncated: { steps: boolean; requests: boolean }
}

export interface RecordingSession {
  sessionId: string
  startedAt: string
  startedAtMs: number
  initialPage: string
  endedAt?: string
  finalPage?: string
  steps: readonly RecordedStep[]
  requests: readonly NetworkRecord[]
  notes: Readonly<Record<string, string>>
  screenshots: readonly RecordedScreenshot[]
  truncated: { steps: boolean; requests: boolean }
}

export function createRecordingSession(now = Date.now()): RecordingSession {
  return {
    sessionId: crypto.randomUUID(),
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    initialPage: window.location.href,
    steps: [],
    requests: [],
    notes: {},
    screenshots: [],
    truncated: { steps: false, requests: false }
  }
}

export function normalizeNote(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim().slice(0, RECORDER_NOTE_MAX_LENGTH)
}

export function requiresDiscardConfirmation(session: RecordingSession): boolean {
  return session.steps.length > 1
    || Object.values(session.notes).some((note) => Boolean(note.trim()))
    || session.screenshots.length > 0
}
