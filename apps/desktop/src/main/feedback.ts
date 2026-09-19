import type { NativeImage, WebContents, WebFrameMain } from 'electron'

import {
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  type FeedbackScreenshotResult
} from '../feedback.ts'

export interface FeedbackCaptureSource {
  capturePage: () => Promise<NativeImage>
}

export async function captureFeedbackScreenshot(
  source: FeedbackCaptureSource
): Promise<FeedbackScreenshotResult> {
  try {
    const image = await source.capturePage()
    if (image.isEmpty()) return { ok: false, error: FEEDBACK_CAPTURE_ERROR.empty }
    const bytes = image.toPNG()
    if (!bytes.byteLength) return { ok: false, error: FEEDBACK_CAPTURE_ERROR.empty }
    if (bytes.byteLength > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      return { ok: false, error: FEEDBACK_CAPTURE_ERROR.tooLarge }
    }
    const size = image.getSize()
    return { ok: true, bytes: new Uint8Array(bytes), width: size.width, height: size.height }
  } catch {
    return { ok: false, error: FEEDBACK_CAPTURE_ERROR.failed }
  }
}

export function isFeedbackCaptureSender(
  sender: WebContents,
  senderFrame: WebFrameMain | null,
  mainWindowContents: WebContents | null | undefined
): boolean {
  return sender === mainWindowContents && senderFrame !== null && senderFrame === sender.mainFrame
}
