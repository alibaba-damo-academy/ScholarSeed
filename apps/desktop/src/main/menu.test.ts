import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const menuSource = readFileSync(new URL('./menu.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('application menu retains native editing roles for focused editor surfaces', () => {
  assert.match(menuSource, /role: ['"]editMenu['"]/)
  assert.match(menuSource, /role: ['"]appMenu['"]/)
  assert.match(menuSource, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\)/)
})

test('main installs the application menu and hides rather than removes the Windows menu bar', () => {
  assert.match(mainSource, /installApplicationMenu\(\)/)
  assert.match(mainSource, /mainWindow\.setMenuBarVisibility\(false\)/)
  assert.doesNotMatch(mainSource, /mainWindow\.setMenu\(null\)/)
})
