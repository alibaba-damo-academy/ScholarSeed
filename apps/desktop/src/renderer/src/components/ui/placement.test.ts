import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { menuPositionStyle } from './placement.ts'

const viewport = { width: 836, height: 660 }
const anchor = { kind: 'anchor' as const, left: 247, right: 275, top: 598, bottom: 626, width: 28 }

test('short folder menu flips directly above its button using measured height', () => {
  const position = menuPositionStyle(anchor, { width: 204, height: 256 }, viewport)
  assert.deepEqual(position, { left: 247, top: 334, position: 'fixed' })
  assert.equal(anchor.top - (Number(position.top) + 256), 8)
})

test('dynamic file menu height keeps the same anchor gap', () => {
  for (const height of [256, 372, 420]) {
    const position = menuPositionStyle(anchor, { width: 204, height }, viewport)
    assert.equal(anchor.top - (Number(position.top) + height), 8)
  }
})

test('menu opens below when there is enough space', () => {
  const position = menuPositionStyle(
    { ...anchor, top: 100, bottom: 128 },
    { width: 204, height: 256 },
    viewport
  )
  assert.equal(position.top, 136)
})

test('menu can prefer opening above its anchor', () => {
  const position = menuPositionStyle(
    { ...anchor, top: 300, bottom: 328 },
    { width: 204, height: 100 },
    viewport,
    'top'
  )
  assert.equal(position.top, 192)
})

test('right click uses the pointer and actual dimensions for viewport collision', () => {
  assert.deepEqual(
    menuPositionStyle({ kind: 'point', x: 275, y: 626 }, { width: 204, height: 256 }, viewport),
    {
      left: 275,
      top: 396,
      position: 'fixed',
    }
  )
  assert.deepEqual(
    menuPositionStyle({ kind: 'point', x: 830, y: 100 }, { width: 204, height: 256 }, viewport),
    {
      left: 624,
      top: 100,
      position: 'fixed',
    }
  )
})

test('narrow viewports constrain menus without negative coordinates', () => {
  assert.deepEqual(
    menuPositionStyle(anchor, { width: 204, height: 256 }, { width: 200, height: 180 }),
    {
      left: 8,
      top: 8,
      position: 'fixed',
    }
  )
})

test('submenu collision still flips to the left', () => {
  const position = menuPositionStyle(
    { ...anchor, left: 650, right: 678, top: 100, bottom: 128 },
    { width: 204, height: 256 },
    viewport,
    'right'
  )
  assert.equal(position.left, 438)
  assert.equal(position.top, 100)
})

test('resource menus use shared measured positioning rather than height estimates', () => {
  const source = readFileSync(
    new URL('../../features/resources/NodeMenu.tsx', import.meta.url),
    'utf8'
  )
  assert.match(source, /position=\{\s*menu\.anchor/)
  assert.doesNotMatch(source, /MENU_HEIGHT|MENU_WIDTH|window\.innerHeight/)
})

test('side menus preserve their configured gap on both sides of the anchor', () => {
  const gap = 5
  const size = { width: 204, height: 100 }
  const right = menuPositionStyle(anchor, size, viewport, 'right', 'start', gap)
  assert.equal(right.left, anchor.right + gap)
  const edgeAnchor = { ...anchor, left: 650, right: 678 }
  const flipped = menuPositionStyle(edgeAnchor, size, viewport, 'right', 'start', gap)
  assert.equal(flipped.left, edgeAnchor.left - size.width - gap)
})

test('resource file menu places version history after copy path and omits version settings', () => {
  const source = readFileSync(
    new URL('../../features/resources/NodeMenu.tsx', import.meta.url),
    'utf8'
  )
  const copyPathIndex = source.indexOf("key: 'copy-path'")
  const versionHistoryIndex = source.indexOf("key: 'version-history'")

  assert.notEqual(copyPathIndex, -1)
  assert.ok(versionHistoryIndex > copyPathIndex)
  assert.doesNotMatch(source, /key: 'version-settings'/)
})
