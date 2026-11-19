import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClipboardItem } from 'electron'

import { writeClipboardContent } from './clipboard.ts'

test('rich clipboard writes one item containing plain and HTML representations', async () => {
  const item = {} as ClipboardItem
  let written: ClipboardItem[] | undefined
  assert.deepEqual(
    await writeClipboardContent(
      {
        write: async (items) => {
          written = items
        },
      },
      item
    ),
    { ok: true }
  )
  assert.deepEqual(written, [item])
})
