import type { Clipboard, ClipboardItem } from 'electron'

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
