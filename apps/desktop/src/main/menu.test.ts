import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { MenuItemConstructorOptions } from 'electron'

const menuSource = readFileSync(new URL('./menu.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function loadMenu() {
  const exports: Record<string, Function> = {}
  const output = ts.transpileModule(menuSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText
  runInNewContext(output, { exports, process, require: () => ({ Menu: {} }) })
  return exports.applicationMenuTemplate as (platform: NodeJS.Platform, development?: boolean) => MenuItemConstructorOptions[]
}

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform} development menu keeps editing and adds only the developer tools action`, () => {
    const template = loadMenu()(platform, true)
    assert.ok(template.some(item => item.role === 'editMenu'))
    assert.ok(template.some(item => item.role === 'windowMenu'))
    const help = template.find(item => item.role === 'help')
    const submenu = help?.submenu as MenuItemConstructorOptions[]
    assert.equal(submenu.length, 1)
    assert.equal(submenu[0].role, 'toggleDevTools')
    assert.equal(template.some(item => item.role === 'viewMenu'), false)
  })

  test(`${platform} normal menu does not expose developer tools`, () => {
    const template = loadMenu()(platform)
    assert.equal(template.some(item => item.role === 'help'), false)
    assert.ok(template.some(item => item.role === 'editMenu'))
  })
}

test('application menu retains native editing roles for focused editor surfaces', () => {
  assert.match(menuSource, /role: ['"]editMenu['"]/)
  assert.match(menuSource, /role: ['"]appMenu['"]/)
  assert.match(menuSource, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\)/)
})

test('main installs the application menu and hides rather than removes the Windows menu bar', () => {
  assert.match(mainSource, /installApplicationMenu\(Boolean\(process\.env\['ELECTRON_RENDERER_URL'\]\) && !headless\)/)
  assert.match(mainSource, /mainWindow\.setMenuBarVisibility\(false\)/)
  assert.doesNotMatch(mainSource, /mainWindow\.setMenu\(null\)/)
})

test('main hides the Windows native title bar while preserving native controls', () => {
  assert.match(mainSource, /titleBarStyle: process\.platform === WINDOWS_PLATFORM \? 'hidden' : 'hiddenInset'/)
  assert.match(mainSource, /titleBarOverlay: process\.platform === WINDOWS_PLATFORM/)
  assert.match(mainSource, /symbolColor: WINDOWS_TITLE_BAR_SYMBOL_COLOR/)
})
