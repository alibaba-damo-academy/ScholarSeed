import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  selectionToolbarPosition,
  shouldClosePointerToolbar
} from './selection-toolbar.ts'

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

test('selection toolbar keeps its placement inside the boundary hysteresis', () => {
  const position = selectionToolbarPosition({
    currentPlacement: 'below',
    devicePixelRatio: 2,
    rootTop: 100,
    selectionBottom: 280,
    selectionTop: 260,
    toolbarHeight: 45,
    visibleBottom: 321,
    visibleTop: 20
  })

  assert.equal(position.placement, 'below')
})

test('selection toolbar changes placement when only the other side fits', () => {
  const position = selectionToolbarPosition({
    currentPlacement: 'below',
    devicePixelRatio: 2,
    rootTop: 100,
    selectionBottom: 300,
    selectionTop: 280,
    toolbarHeight: 48,
    visibleBottom: 320,
    visibleTop: 20
  })

  assert.equal(position.placement, 'above')
  assert.equal(position.top, 180)
})

test('selection toolbar position is normalized to a device pixel', () => {
  const position = selectionToolbarPosition({
    currentPlacement: 'below',
    devicePixelRatio: 2,
    rootTop: 100.1,
    selectionBottom: 240.34,
    selectionTop: 220.34,
    toolbarHeight: 40.2,
    visibleBottom: 500,
    visibleTop: 20
  })

  assert.equal(position.top, 140)
})
