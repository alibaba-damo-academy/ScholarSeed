import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { shouldClosePointerToolbar } from './selection-toolbar.ts'

const LEFT_BUTTON = 0
const RIGHT_BUTTON = 2

test('a right-click on the selected text keeps the toolbar and selection intact', () => {
  // Right-click on the annotated selection: the native copy menu owns this
  // gesture — the toolbar must not close and the selection must survive.
  assert.equal(shouldClosePointerToolbar(RIGHT_BUTTON, false, true), false)
})

test('a right-click outside the annotated root still closes the draft', () => {
  assert.equal(shouldClosePointerToolbar(RIGHT_BUTTON, false, false), true)
})

test('a left-click outside the toolbar always closes the draft', () => {
  assert.equal(shouldClosePointerToolbar(LEFT_BUTTON, false, true), true)
  assert.equal(shouldClosePointerToolbar(LEFT_BUTTON, false, false), true)
})

test('clicking the toolbar itself never closes it, regardless of button', () => {
  assert.equal(shouldClosePointerToolbar(LEFT_BUTTON, true, false), false)
  assert.equal(shouldClosePointerToolbar(RIGHT_BUTTON, true, true), false)
})

test('Annotations.tsx delegates the outside-pointer check to shouldClosePointerToolbar', () => {
  const source = readFileSync(new URL('./Annotations.tsx', import.meta.url), 'utf8')

  assert.match(source, /shouldClosePointerToolbar\(\s*event\.button,/)
  assert.match(source, /toolbarRef\.current\?\.contains\(target\) \?\? false,/)
  assert.match(source, /rootRef\.current\?\.contains\(target\) \?\? false/)
})
