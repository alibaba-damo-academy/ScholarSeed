export const RECORDER_ROOT_ATTRIBUTE = 'data-feedback-recorder-root'
export const RECORDER_MAX_STEPS = 500
export const RECORDER_MAX_REQUESTS = 300
export const RECORDER_NOTE_MAX_LENGTH = 500
export const RECORDER_REPORT_MAX_BYTES = 2 * 1024 * 1024
export const RECORDER_DESCRIPTION_MAX_LENGTH = 5000
export const RECORDER_SCHEMA_VERSION = 1 as const
export const RECORDING_REPORT_TOO_LARGE = 'recording_report_too_large'

export type RecorderPhase =
  'idle' | 'recording' | 'paused' | 'annotating' | 'review' | 'submitting' | 'done'

export type StepKind = 'click' | 'input' | 'change' | 'navigation'

export interface PageContext {
  url: string
  title: string
  path?: string
  label?: string
  dialogLabel?: string
}

export type TargetLocatorKind =
  'testId' | 'ariaLabel' | 'roleName' | 'id' | 'name' | 'href' | 'text' | 'tag'

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
  /**
   * 客户端主动取消 (换作用域、切页面、卸载、请求超时器) 而不是接口失败。
   *
   * 取消在 fetch 上表现为一次 reject, 与真实故障无法只靠 `error` 文本区分; 不标出来,
   * 报告里就会出现「GET … → signal is aborted without reason」这种把正常取消当故障的行,
   * 诊断时会去追一个不存在的服务端问题。原始 reason 仍留在 `error` 里备查。
   */
  cancelled?: boolean
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
  | {
      type: 'rect'
      color: string
      lineWidth?: number
      x: number
      y: number
      width: number
      height: number
    }
  | { type: 'redact'; x: number; y: number; width: number; height: number }
  | { type: 'arrow'; color: string; lineWidth?: number; points: [AnnotationPoint, AnnotationPoint] }
  | { type: 'pen'; color: string; lineWidth?: number; points: AnnotationPoint[] }
  | { type: 'text'; color: string; fontSize?: number; x: number; y: number; text: string }

export interface RecordedScreenshot {
  automatic?: boolean
  screenshotId: string
  stepId?: string
  note: string
  sourceFile: File
  renderedFile: File
  previewUrl: string
  annotations: Annotation[]
}

export type ScreenshotRendering = Pick<
  RecordedScreenshot,
  'annotations' | 'note' | 'previewUrl' | 'renderedFile'
>

type InitialScreenshot = Pick<
  RecordedScreenshot,
  'previewUrl' | 'renderedFile' | 'screenshotId' | 'sourceFile'
>

export function appendInitialScreenshot(
  session: RecordingSession,
  screenshot: InitialScreenshot
): RecordingSession {
  const initialStep = session.steps[0]
  if (!initialStep) return session
  return {
    ...session,
    screenshots: [
      ...session.screenshots,
      {
        ...screenshot,
        annotations: [],
        automatic: true,
        note: '',
        stepId: initialStep.stepId,
      },
    ],
  }
}

type RectangleAnnotation = Extract<Annotation, { type: 'rect' | 'redact' }>

export function normalizeRectangleAnnotation<T extends RectangleAnnotation>(annotation: T): T {
  return {
    ...annotation,
    x: annotation.width < 0 ? annotation.x + annotation.width : annotation.x,
    y: annotation.height < 0 ? annotation.y + annotation.height : annotation.y,
    width: Math.abs(annotation.width),
    height: Math.abs(annotation.height),
  }
}

export function replaceRecordedScreenshot(
  screenshot: RecordedScreenshot,
  rendering: ScreenshotRendering
): RecordedScreenshot {
  return { ...screenshot, ...rendering }
}

export function selectFeedbackImages(session: RecordingSession): File[] {
  const stepIds = new Set(session.steps.map((step) => step.stepId))
  return session.screenshots
    .filter((screenshot) => Boolean(screenshot.stepId && stepIds.has(screenshot.stepId)))
    .map((screenshot) => screenshot.renderedFile)
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
  submittedStepNotes?: readonly StepNote[]
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
  submittedNotes?: Readonly<Record<string, readonly string[]>>
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
    truncated: { steps: false, requests: false },
  }
}

export function normalizeNote(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim().slice(0, RECORDER_NOTE_MAX_LENGTH)
}

export function requiresDiscardConfirmation(session: RecordingSession): boolean {
  return (
    session.steps.length > 1 ||
    Object.values(session.notes).some((note) => Boolean(note.trim())) ||
    session.screenshots.some(
      (screenshot) =>
        !screenshot.automatic ||
        screenshot.annotations.length > 0 ||
        Boolean(screenshot.note.trim())
    )
  )
}
