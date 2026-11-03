export const SOURCE_BASELINE_ARCNAME = 'feedback/source-baseline.json'
export const FEEDBACK_DIAGNOSTICS_CHANNEL = 'scholarseed:feedback-diagnostics'
export const FEEDBACK_SUBMIT_CHANNEL = 'scholarseed:feedback-submit'
export const FEEDBACK_SUBMIT_PATH = '/api/v1/feedback/submit'
export const FEEDBACK_BUNDLE_PATH = '/api/serve/feedback/bundle'
export const FEEDBACK_DEFAULT_BASE_URL = 'https://scholarseed.damo.alibaba.com'
export const FEEDBACK_HTTP_RATE_LIMITED = 429
export const FEEDBACK_LIMITS = Object.freeze({
  description: 5000,
  filename: 255,
  images: 5,
  imageBytes: 20 * 1024 * 1024,
  imagesBytes: 40 * 1024 * 1024,
  reportBytes: 2 * 1024 * 1024,
  bundleBytes: 40 * 1024 * 1024,
  responseBytes: 256 * 1024,
  hostBytes: 256 * 1024,
  submitTimeoutMs: 60000,
  collectionTimeoutMs: 10000,
  credentialTimeoutMs: 5000,
})
export interface FeedbackAttachment {
  name: string
  type: string
  bytes: Uint8Array
}
export interface FeedbackSubmissionRequest {
  description: string
  email?: string
  includeLogs: boolean
  includeTrace: boolean
  sessionId?: string | null
  images: FeedbackAttachment[]
  recordingReport?: Uint8Array
  rendererDiagnostics?: Uint8Array
}
export type FeedbackSubmissionError =
  'invalid_request' | 'invalid_sender' | 'busy' | 'unavailable' | 'failed' | 'identity_changed'
export interface FeedbackSubmissionResult {
  ok: boolean
  id?: string
  code?: FeedbackSubmissionError
  rateLimited?: boolean
  diagnostics?: 'complete' | 'partial' | 'not_requested'
}
export function feedbackSubmissionForm(
  request: FeedbackSubmissionRequest,
  includeImages = true
): FormData {
  const body = new FormData()
  body.set('description', request.description)
  if (request.email) body.set('email', request.email)
  body.set('include_logs', String(request.includeLogs))
  body.set('include_trace', String(request.includeLogs && request.includeTrace))
  if (request.sessionId) body.set('session_id', request.sessionId)
  if (includeImages)
    for (const image of request.images)
      body.append(
        'images',
        new Blob([new Uint8Array(image.bytes)], { type: image.type }),
        image.name
      )
  if (request.recordingReport)
    body.set(
      'recording_report',
      new Blob([new Uint8Array(request.recordingReport)], { type: 'application/json' }),
      'recording-report.json'
    )
  if (request.rendererDiagnostics)
    body.set(
      'renderer_diagnostics',
      new Blob([new Uint8Array(request.rendererDiagnostics)], { type: 'application/json' }),
      'renderer-diagnostics.json'
    )
  return body
}
export const FEEDBACK_CAPTURE_CHANNEL = 'scholarseed:feedback-capture'
export const FEEDBACK_SHORTCUT_CHANNEL = 'scholarseed:feedback-shortcut'
export const FEEDBACK_RECORDER_START_EVENT = 'scholarseed:feedback-recorder-start'
export const FEEDBACK_SHORTCUT = Object.freeze({
  code: 'KeyF',
  key: 'f',
  macLabel: '⌘+⌥+F',
  otherLabel: 'Ctrl+Alt+F',
} as const)
export const FEEDBACK_CLIPBOARD_IMAGE_CHANNEL = 'scholarseed:write-clipboard-image'
export const FEEDBACK_SCREENSHOT_MIME_TYPE = 'image/png'
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 20 * 1024 * 1024
export const FEEDBACK_CAPTURE_ERROR = Object.freeze({
  failed: 'capture_failed',
  empty: 'capture_empty',
  tooLarge: 'capture_too_large',
  invalidSender: 'invalid_sender',
} as const)
export type FeedbackCaptureError =
  (typeof FEEDBACK_CAPTURE_ERROR)[keyof typeof FEEDBACK_CAPTURE_ERROR]

export interface FeedbackScreenshotLayer {
  bytes: Uint8Array
  bounds: { x: number; y: number; width: number; height: number }
}

export type FeedbackScreenshotResult =
  | {
      ok: true
      bytes: Uint8Array
      width: number
      height: number
      layers?: FeedbackScreenshotLayer[]
      viewport?: { width: number; height: number }
    }
  | { ok: false; error: FeedbackCaptureError }

export const FEEDBACK_CLIPBOARD_IMAGE_ERROR = Object.freeze({
  empty: 'clipboard_image_empty',
  failed: 'clipboard_image_write_failed',
  unavailable: 'clipboard_image_write_unavailable',
} as const)
export type FeedbackClipboardImageError =
  (typeof FEEDBACK_CLIPBOARD_IMAGE_ERROR)[keyof typeof FEEDBACK_CLIPBOARD_IMAGE_ERROR]

export type FeedbackClipboardImageResult =
  { ok: true } | { ok: false; error: FeedbackClipboardImageError }
