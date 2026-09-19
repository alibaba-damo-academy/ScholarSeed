export const FEEDBACK_CAPTURE_CHANNEL = 'scholarseed:feedback-capture'
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 20 * 1024 * 1024
export const FEEDBACK_CAPTURE_ERROR = Object.freeze({
  failed: 'capture_failed',
  empty: 'capture_empty',
  tooLarge: 'capture_too_large',
  invalidSender: 'invalid_sender'
} as const)
export type FeedbackCaptureError = (typeof FEEDBACK_CAPTURE_ERROR)[keyof typeof FEEDBACK_CAPTURE_ERROR]

export type FeedbackScreenshotResult =
  | { ok: true; bytes: Uint8Array; width: number; height: number }
  | { ok: false; error: FeedbackCaptureError }
