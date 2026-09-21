import type { Clipboard, ClipboardItem } from 'electron'

export const MAX_OFFICE_CLIPBOARD_BYTES = 16 * 1024 * 1024

export type OfficeClipboardMime = 'text/html' | 'text/rtf' | 'text/plain'

export interface OfficeClipboardFormat {
  mime: OfficeClipboardMime
  data: string
}

export interface OfficeClipboardSource {
  readHTML: () => Promise<string>
  readRTF: () => Promise<string>
  readText: () => Promise<string>
}

export type OfficeClipboardResult =
  | { ok: true; formats: OfficeClipboardFormat[] }
  | { ok: false; error: 'clipboard_empty' | 'clipboard_failed' | 'clipboard_forbidden' | 'clipboard_too_large' }

export async function writeClipboardContent(
  sink: Pick<Clipboard, 'write'>,
  item: ClipboardItem
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await sink.write([item])
    return { ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export async function readOfficeClipboard(source: OfficeClipboardSource): Promise<OfficeClipboardResult> {
  try {
    const formats = [
      { mime: 'text/html', data: await source.readHTML() },
      { mime: 'text/rtf', data: await source.readRTF() },
      { mime: 'text/plain', data: await source.readText() }
    ].filter((format) => format.data.length > 0) as OfficeClipboardFormat[]
    if (!formats.length) return { ok: false, error: 'clipboard_empty' }
    if (formats.some((format) => Buffer.byteLength(format.data, 'utf8') > MAX_OFFICE_CLIPBOARD_BYTES)) {
      return { ok: false, error: 'clipboard_too_large' }
    }
    return { ok: true, formats }
  } catch {
    return { ok: false, error: 'clipboard_failed' }
  }
}
