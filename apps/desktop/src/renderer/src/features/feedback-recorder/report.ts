import {
  RECORDER_DESCRIPTION_MAX_LENGTH,
  RECORDER_REPORT_MAX_BYTES,
  RECORDER_SCHEMA_VERSION,
  type RecordingReport,
  type RecordingSession,
  type SummaryFields
} from './model.ts'
import { targetDisplayLabel, targetLabel, targetLocatorLabel } from './target.ts'

const SUMMARY_STEP_LIMIT = 5
const REPORT_FILENAME = 'feedback-recording.json'
const DESCRIPTION_LINE_BREAK = '\r\n'
const DESCRIPTION_LINE_BREAK_PATTERN = /\r\n|\r|\n/g

export interface SummaryLabels {
  step: (index: number, kind: string, target: string, note: string) => string
  screenshots: (count: number) => string
  screenshotNote: (index: number, note: string) => string
  empty: string
}

export interface DescriptionLabels {
  actual: string
  expected: string
  additional: string
  operations: string
  requests: string
  empty: string
  moreInReport: string
  page: (value: string) => string
  dialog: (value: string) => string
  locator: (value: string) => string
  containers: (value: string) => string
  pointer: (x: number, y: number) => string
  bounds: (x: number, y: number, width: number, height: number) => string
  operation: (
    index: number,
    occurredAt: string,
    elapsedMs: number,
    kind: string,
    target: string,
    value: string,
    note: string,
    diagnostics: string
  ) => string
  request: (
    index: number,
    startedAt: string,
    elapsedMs: number,
    method: string,
    url: string,
    status: string,
    durationMs: number,
    linkedStep: number | undefined
  ) => string
}

export interface PreparedDescription {
  description: string
  truncated: boolean
}

function sliceWithoutSplittingSurrogatePair(value: string, end: number): string {
  const boundedEnd = Math.max(0, Math.min(value.length, end))
  const previousCodeUnit = value.charCodeAt(boundedEnd - 1)
  const nextCodeUnit = value.charCodeAt(boundedEnd)
  const endsWithHighSurrogate = previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF
  const continuesWithLowSurrogate = nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF
  return value.slice(0, endsWithHighSurrogate && continuesWithLowSurrogate ? boundedEnd - 1 : boundedEnd)
}

export function prepareDescriptionForSubmission(
  value: string,
  truncationNotice: string
): PreparedDescription {
  const normalized = value.replace(DESCRIPTION_LINE_BREAK_PATTERN, DESCRIPTION_LINE_BREAK)
  if (normalized.length <= RECORDER_DESCRIPTION_MAX_LENGTH) {
    return { description: normalized, truncated: false }
  }
  const suffix = `${DESCRIPTION_LINE_BREAK}${DESCRIPTION_LINE_BREAK}${truncationNotice}`
  const prefixLimit = RECORDER_DESCRIPTION_MAX_LENGTH - suffix.length
  const prefix = sliceWithoutSplittingSurrogatePair(normalized, prefixLimit).trimEnd()
  return {
    description: `${prefix}${suffix}`,
    truncated: true
  }
}

export function generateSummary(session: RecordingSession, labels: SummaryLabels): string {
  const noted = session.steps.filter((step) => session.notes[step.stepId])
  const important = (noted.length ? noted : session.steps).slice(0, SUMMARY_STEP_LIMIT)
  const lines = important.map((step, index) => {
    const note = session.notes[step.stepId]
    return labels.step(index + 1, step.kind, targetDisplayLabel(step.target), note || '')
  })
  if (session.screenshots.length) lines.push(labels.screenshots(session.screenshots.length))
  session.screenshots
    .filter((screenshot) => Boolean(screenshot.note))
    .slice(0, SUMMARY_STEP_LIMIT)
    .forEach((screenshot, index) => lines.push(labels.screenshotNote(index + 1, screenshot.note)))
  return lines.length ? lines.join('\n') : labels.empty
}

function appendBoundedSection(
  description: string,
  title: string,
  lines: readonly string[],
  labels: Pick<DescriptionLabels, 'empty' | 'moreInReport'>
): string {
  const entries = lines.length ? lines : [labels.empty]
  const separator = description ? '\n\n' : ''
  const header = `${separator}${title}\n`
  if (description.length + header.length > RECORDER_DESCRIPTION_MAX_LENGTH) return description
  let section = header
  for (let index = 0; index < entries.length; index += 1) {
    const line = `${index ? '\n' : ''}${entries[index]}`
    const hasMore = index < entries.length - 1
    const reservedNotice = hasMore ? `\n${labels.moreInReport}` : ''
    if (
      description.length + section.length + line.length + reservedNotice.length
      <= RECORDER_DESCRIPTION_MAX_LENGTH
    ) {
      section += line
      continue
    }
    const notice = `${section.endsWith('\n') ? '' : '\n'}${labels.moreInReport}`
    if (description.length + section.length + notice.length <= RECORDER_DESCRIPTION_MAX_LENGTH) {
      section += notice
    }
    break
  }
  return `${description}${section}`
}

export function composeFinalDescription(
  fields: SummaryFields,
  labels: DescriptionLabels,
  session?: RecordingSession
): string {
  const parts = [
    fields.final.trim(),
    fields.actual.trim() ? `${labels.actual}\n${fields.actual.trim()}` : '',
    fields.expected.trim() ? `${labels.expected}\n${fields.expected.trim()}` : '',
    fields.additional.trim() ? `${labels.additional}\n${fields.additional.trim()}` : ''
  ].filter(Boolean)
  let description = parts.join('\n\n')
  if (!session || description.length > RECORDER_DESCRIPTION_MAX_LENGTH) return description

  const stepNumberById = new Map(session.steps.map((step, index) => [step.stepId, index + 1]))
  const operationLines = session.steps.map((step, index) => labels.operation(
    index + 1,
    step.occurredAt,
    step.elapsedMs,
    step.kind,
    targetLabel(step.target),
    step.value || '',
    session.notes[step.stepId] || '',
    [
      labels.page(
        step.page.label || (step.page.path && step.page.path !== '/'
          ? step.page.path
          : `${step.page.title} | ${step.page.url}`)
      ),
      step.page.dialogLabel ? labels.dialog(step.page.dialogLabel) : '',
      labels.locator(targetLocatorLabel(step.target)),
      step.target.containerTestIds?.length
        ? labels.containers(step.target.containerTestIds.join(' > '))
        : '',
      step.pointer ? labels.pointer(step.pointer.x, step.pointer.y) : '',
      step.target.bounds
        ? labels.bounds(
          step.target.bounds.x,
          step.target.bounds.y,
          step.target.bounds.width,
          step.target.bounds.height
        )
        : ''
    ].filter(Boolean).join(' | ')
  ))
  description = appendBoundedSection(description, labels.operations, operationLines, labels)

  const requestLines = session.requests.map((request, index) => {
    const startedAtMs = Date.parse(request.startedAt)
    const elapsedMs = Number.isFinite(startedAtMs)
      ? Math.max(0, startedAtMs - session.startedAtMs)
      : 0
    return labels.request(
      index + 1,
      request.startedAt,
      elapsedMs,
      request.method,
      request.url,
      request.status === undefined ? request.error || '-' : String(request.status),
      request.durationMs,
      request.stepId ? stepNumberById.get(request.stepId) : undefined
    )
  })
  return appendBoundedSection(description, labels.requests, requestLines, labels)
}

export function buildRecordingReport(
  session: RecordingSession,
  endedAt: string,
  summary: SummaryFields
): RecordingReport {
  const stepIds = new Set(session.steps.map((step) => step.stepId))
  return {
    schemaVersion: RECORDER_SCHEMA_VERSION,
    session: {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt,
      initialPage: session.initialPage,
      finalPage: session.finalPage || session.initialPage,
      status: 'completed'
    },
    steps: session.steps,
    stepNotes: Object.entries(session.notes)
      .filter(([, text]) => Boolean(text))
      .map(([stepId, text]) => ({ stepId, text })),
    requests: session.requests,
    screenshots: session.screenshots.filter((screenshot) => screenshot.stepId && stepIds.has(screenshot.stepId)).map((screenshot) => ({
      screenshotId: screenshot.screenshotId,
      ...(screenshot.stepId ? { stepId: screenshot.stepId } : {}),
      note: screenshot.note,
      filename: screenshot.renderedFile.name
    })),
    summary,
    truncated: session.truncated
  }
}

export function reportFile(report: RecordingReport): File {
  const contents = JSON.stringify(report, null, 2)
  const blob = new Blob([contents], { type: 'application/json' })
  if (blob.size > RECORDER_REPORT_MAX_BYTES) throw new Error('recording_report_too_large')
  return new File([blob], REPORT_FILENAME, { type: 'application/json' })
}
