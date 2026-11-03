import type { Clipboard, ClipboardItem, NativeImage, WebContents, WebFrameMain } from 'electron'

import {
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_CLIPBOARD_IMAGE_ERROR,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SHORTCUT,
  type FeedbackClipboardImageResult,
  type FeedbackScreenshotResult,
  type FeedbackScreenshotLayer,
} from '../feedback.ts'

export interface FeedbackCaptureSource {
  capturePage: () => Promise<NativeImage>
}

interface FeedbackCaptureLayers {
  viewport: { width: number; height: number }
  layers: (FeedbackCaptureSource & {
    bounds: { x: number; y: number; width: number; height: number }
  })[]
}

interface FeedbackKeyboardInput {
  type: string
  key: string
  code?: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  isAutoRepeat?: boolean
}

const KEY_DOWN_EVENT = 'keyDown'
const MAC_PLATFORM = 'darwin'

export function matchesFeedbackShortcut(input: FeedbackKeyboardInput, platform: string): boolean {
  return (
    input.type === KEY_DOWN_EVENT &&
    !input.isAutoRepeat &&
    !input.shift &&
    input.alt &&
    (input.code
      ? input.code === FEEDBACK_SHORTCUT.code
      : input.key.toLowerCase() === FEEDBACK_SHORTCUT.key) &&
    (platform === MAC_PLATFORM ? input.meta && !input.control : input.control && !input.meta)
  )
}

export async function writeFeedbackClipboardImage(
  sink: Pick<Clipboard, 'write'>,
  item: ClipboardItem
): Promise<FeedbackClipboardImageResult> {
  try {
    await sink.write([item])
    return { ok: true }
  } catch {
    return { ok: false, error: FEEDBACK_CLIPBOARD_IMAGE_ERROR.failed }
  }
}

export async function captureFeedbackScreenshot(
  source: FeedbackCaptureSource,
  options?: FeedbackCaptureLayers
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
    if (options?.layers.length) {
      const captures = await Promise.all(
        options.layers.map((layer) => captureFeedbackScreenshot(layer))
      )
      const layers: FeedbackScreenshotLayer[] = []
      for (const [index, captured] of captures.entries()) {
        if (!captured.ok) return captured
        layers.push({ bytes: captured.bytes, bounds: options.layers[index].bounds })
      }
      if (
        bytes.byteLength + layers.reduce((total, layer) => total + layer.bytes.byteLength, 0) >
        FEEDBACK_SCREENSHOT_MAX_BYTES
      ) {
        return { ok: false, error: FEEDBACK_CAPTURE_ERROR.tooLarge }
      }
      return {
        ok: true,
        bytes: new Uint8Array(bytes),
        width: size.width,
        height: size.height,
        layers,
        viewport: options.viewport,
      }
    }
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
