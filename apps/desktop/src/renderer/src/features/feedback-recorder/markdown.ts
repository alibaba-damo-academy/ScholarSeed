import type { RecordingSession, StepKind, SummaryFields } from './model.ts'
import { targetDisplayLabel } from './target.ts'

const CLOCK_PART_WIDTH = 2
const MILLISECOND_PART_WIDTH = 3
const STEP_NUMBER_OFFSET = 1
const UNKNOWN_CLOCK_LABEL = '--:--:--.---'
const PAGE_LANDMARK_TAGS = new Set(['main', 'section', 'aside'])
const BASE64_CHUNK_BYTES = 32 * 1024

export interface ReviewMarkdownLabels {
  title: string
  summary: string
  steps: string
  action: (kind: StepKind) => string
  sourcePage: (page: string) => string
  sourceDialog: (page: string, dialog: string) => string
  elapsed: (value: number) => string
  note: (value: string) => string
  input: string
  emptyValue: string
  screenshots: string
  screenshotNote: string
  operation: string
  target: string
  time: string
}

export function formatClockTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return UNKNOWN_CLOCK_LABEL
  const hours = String(date.getHours()).padStart(CLOCK_PART_WIDTH, '0')
  const minutes = String(date.getMinutes()).padStart(CLOCK_PART_WIDTH, '0')
  const seconds = String(date.getSeconds()).padStart(CLOCK_PART_WIDTH, '0')
  const milliseconds = String(date.getMilliseconds()).padStart(MILLISECOND_PART_WIDTH, '0')
  return `${hours}:${minutes}:${seconds}.${milliseconds}`
}

export function reviewTargetLabel(step: RecordingSession['steps'][number]): string {
  if (PAGE_LANDMARK_TAGS.has(step.target.tag) && step.page.label) return step.page.label
  return targetDisplayLabel(step.target)
}

export function composeReviewMarkdown(
  session: RecordingSession,
  summary: SummaryFields,
  labels: ReviewMarkdownLabels
): string {
  const lines = [`# ${labels.title}`, '', `## ${labels.summary}`, '', summary.final.trim(), '', `## ${labels.steps}`, '']
  session.steps.forEach((step, index) => {
    const page = step.page.label || step.page.title
    const source = step.page.dialogLabel
      ? labels.sourceDialog(page, step.page.dialogLabel)
      : labels.sourcePage(page)
    const screenshots = session.screenshots.filter((screenshot) => screenshot.stepId === step.stepId)
    const target = reviewTargetLabel(step)
    lines.push(`### ${index + STEP_NUMBER_OFFSET}. ${source}`)
    lines.push(`- **${labels.operation}**：${labels.action(step.kind)}`)
    if (target) lines.push(`- **${labels.target}**：${target}`)
    lines.push(`- **${labels.time}**：${formatClockTime(step.occurredAt)}（${labels.elapsed(step.elapsedMs)}）`)
    const note = session.notes[step.stepId]
    if (note) lines.push(`- ${labels.note(note)}`)
    if (step.value !== undefined) lines.push(`- ${labels.input}${step.value || labels.emptyValue}`)
    if (screenshots.length) {
      lines.push(`- **${labels.screenshots}**：${screenshots.length}`)
      screenshots.forEach((screenshot, screenshotIndex) => {
        const suffix = screenshot.note ? `：${screenshot.note}` : ''
        lines.push(`  - ${labels.screenshotNote} ${screenshotIndex + STEP_NUMBER_OFFSET}${suffix}`)
      })
    }
    lines.push('')
  })
  return lines.join('\n').trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function composeReviewHtml(
  session: RecordingSession,
  summary: SummaryFields,
  labels: ReviewMarkdownLabels,
  screenshotSources: Readonly<Record<string, string>> = {}
): string {
  const sections = [
    `<h1>${escapeHtml(labels.title)}</h1>`,
    `<h2>${escapeHtml(labels.summary)}</h2>`,
    `<p>${escapeHtml(summary.final.trim())}</p>`,
    `<h2>${escapeHtml(labels.steps)}</h2>`
  ]
  session.steps.forEach((step, index) => {
    const page = step.page.label || step.page.title
    const source = step.page.dialogLabel
      ? labels.sourceDialog(page, step.page.dialogLabel)
      : labels.sourcePage(page)
    const target = reviewTargetLabel(step)
    const details = [
      `<li><strong>${escapeHtml(labels.operation)}</strong>：${escapeHtml(labels.action(step.kind))}</li>`
    ]
    if (target) details.push(`<li><strong>${escapeHtml(labels.target)}</strong>：${escapeHtml(target)}</li>`)
    details.push(`<li><strong>${escapeHtml(labels.time)}</strong>：${escapeHtml(formatClockTime(step.occurredAt))}（${escapeHtml(labels.elapsed(step.elapsedMs))}）</li>`)
    const note = session.notes[step.stepId]
    if (note) details.push(`<li>${escapeHtml(labels.note(note))}</li>`)
    if (step.value !== undefined) details.push(`<li>${escapeHtml(labels.input)}${escapeHtml(step.value || labels.emptyValue)}</li>`)
    const screenshots = session.screenshots.filter((screenshot) => screenshot.stepId === step.stepId)
    if (screenshots.length) {
      details.push(`<li><strong>${escapeHtml(labels.screenshots)}</strong>：${screenshots.length}</li>`)
    }
    const figures = screenshots.flatMap((screenshot, screenshotIndex) => {
      const screenshotSource = screenshotSources[screenshot.screenshotId]
      if (!screenshotSource) return []
      const caption = `${labels.screenshotNote} ${screenshotIndex + STEP_NUMBER_OFFSET}${screenshot.note ? `：${screenshot.note}` : ''}`
      return [`<figure><img src="${escapeHtml(screenshotSource)}" alt="${escapeHtml(caption)}" style="max-width:100%;height:auto;"><figcaption>${escapeHtml(caption)}</figcaption></figure>`]
    })
    sections.push(
      `<h3>${index + STEP_NUMBER_OFFSET}. ${escapeHtml(source)}</h3>`,
      `<ul>${details.join('')}</ul>`,
      ...figures
    )
  })
  return `<div>${sections.join('')}</div>`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }
  return btoa(binary)
}

export async function screenshotDataUrls(
  screenshots: RecordingSession['screenshots']
): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(screenshots.map(async (screenshot) => {
    const bytes = new Uint8Array(await screenshot.file.arrayBuffer())
    const mimeType = screenshot.file.type || 'image/png'
    return [screenshot.screenshotId, `data:${mimeType};base64,${bytesToBase64(bytes)}`] as const
  }))
  return Object.fromEntries(entries)
}
