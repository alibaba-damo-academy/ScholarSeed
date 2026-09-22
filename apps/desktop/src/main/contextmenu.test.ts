import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { canCopySelection, SELECTION_COPY_ROLE } from './contextmenu.ts'

test('native copy menu is available only for a copyable text selection', () => {
  assert.equal(canCopySelection({ selectionText: '局部结果', canCopy: true }), true)
  assert.equal(canCopySelection({ selectionText: '   ', canCopy: true }), false)
  assert.equal(canCopySelection({ selectionText: '局部结果', canCopy: false }), false)
  assert.equal(SELECTION_COPY_ROLE, 'copy')
})

test('main window installs the native selection copy menu', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  assert.match(source, /webContents\.on\('context-menu'/)
  assert.match(source, /canCopySelection\(\{ selectionText: params\.selectionText, canCopy: params\.editFlags\.canCopy \}\)/)
  assert.match(source, /Menu\.buildFromTemplate\(\[\{ role: SELECTION_COPY_ROLE \}\]\)\.popup/)
})
