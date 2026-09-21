export const FEEDBACK_CAPTURE_CHANNEL = 'scholarseed:feedback-capture'
export const FEEDBACK_CLIPBOARD_IMAGE_CHANNEL = 'scholarseed:write-clipboard-image'
export const FEEDBACK_SCREENSHOT_MIME_TYPE = 'image/png'
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

export const FEEDBACK_CLIPBOARD_IMAGE_ERROR = Object.freeze({
  empty: 'clipboard_image_empty',
  failed: 'clipboard_image_write_failed',
  unavailable: 'clipboard_image_write_unavailable'
} as const)
export type FeedbackClipboardImageError =
  (typeof FEEDBACK_CLIPBOARD_IMAGE_ERROR)[keyof typeof FEEDBACK_CLIPBOARD_IMAGE_ERROR]

export type FeedbackClipboardImageResult =
  | { ok: true }
  | { ok: false; error: FeedbackClipboardImageError }
