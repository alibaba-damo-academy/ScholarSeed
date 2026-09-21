import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClipboardItem } from 'electron'

import { readOfficeClipboard, writeClipboardContent, type OfficeClipboardSource } from './clipboard.ts'

function source(values: Partial<Record<'html' | 'rtf' | 'text', string>>): OfficeClipboardSource {
  return {
    readHTML: async () => values.html ?? '',
    readRTF: async () => values.rtf ?? '',
    readText: async () => values.text ?? ''
  }
}

test('Office clipboard preserves rich formats in preferred order with a plain fallback', async () => {
  assert.deepEqual(await readOfficeClipboard(source({
    html: '<table><tr><td>Alpha</td></tr></table>',
    rtf: '{\\rtf1 Alpha}',
    text: 'Alpha'
  })), {
    ok: true,
    formats: [
      { mime: 'text/html', data: '<table><tr><td>Alpha</td></tr></table>' },
      { mime: 'text/rtf', data: '{\\rtf1 Alpha}' },
      { mime: 'text/plain', data: 'Alpha' }
    ]
  })
})

test('Office clipboard reports an empty clipboard without inventing content', async () => {
  assert.deepEqual(await readOfficeClipboard(source({})), { ok: false, error: 'clipboard_empty' })
})

test('Office clipboard rejects oversized rich payloads before crossing IPC', async () => {
  assert.deepEqual(await readOfficeClipboard(source({ html: 'x'.repeat(16 * 1024 * 1024 + 1) })), {
    ok: false,
    error: 'clipboard_too_large'
  })
})

test('rich clipboard writes one item containing plain and HTML representations', async () => {
  const item = {} as ClipboardItem
  let written: ClipboardItem[] | undefined
  assert.deepEqual(
    await writeClipboardContent({ write: async (items) => { written = items } }, item),
    { ok: true }
  )
  assert.deepEqual(written, [item])
})
