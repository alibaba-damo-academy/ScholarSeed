import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { MenuItemConstructorOptions } from 'electron'
import { createWorkspaceWindowOptions } from './window.ts'

const menuSource = readFileSync(new URL('./menu.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function loadMenu() {
  const exports: Record<string, Function> = {}
  const output = ts.transpileModule(menuSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  runInNewContext(output, { exports, process, require: () => ({ Menu: {} }) })
  return exports.applicationMenuTemplate as (
    platform: NodeJS.Platform,
    development?: boolean
  ) => MenuItemConstructorOptions[]
}

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform} development menu keeps editing and adds only the developer tools action`, () => {
    const template = loadMenu()(platform, true)
    assert.ok(template.some((item) => item.role === 'editMenu'))
    assert.ok(template.some((item) => item.role === 'windowMenu'))
    const help = template.find((item) => item.role === 'help')
    const submenu = help?.submenu as MenuItemConstructorOptions[]
    assert.equal(submenu.length, 1)
    assert.equal(submenu[0].role, 'toggleDevTools')
    assert.equal(
      template.some((item) => item.role === 'viewMenu'),
      false
    )
  })

  test(`${platform} normal menu does not expose developer tools`, () => {
    const template = loadMenu()(platform)
    assert.equal(
      template.some((item) => item.role === 'help'),
      false
    )
    assert.ok(template.some((item) => item.role === 'editMenu'))
  })
}

test('application menu retains native editing roles for focused editor surfaces', () => {
  assert.match(menuSource, /role: ['"]editMenu['"]/)
  assert.match(menuSource, /role: ['"]appMenu['"]/)
  assert.match(menuSource, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\)/)
})

test('main installs the application menu and hides rather than removes the Windows menu bar', () => {
  assert.match(
    mainSource,
    /installApplicationMenu\(Boolean\(process\.env\['ELECTRON_RENDERER_URL'\]\) && !headless\)/
  )
  assert.match(mainSource, /mainWindow\.setMenuBarVisibility\(false\)/)
  assert.doesNotMatch(mainSource, /mainWindow\.setMenu\(null\)/)
})

test('main keeps the native Windows titlebar while preserving macOS hiddenInset', () => {
  assert.match(
    mainSource,
    /new BrowserWindow\(\s*createWorkspaceWindowOptions\(\{\s*platform: process\.platform,/
  )
  assert.match(
    mainSource,
    /process\.platform === WINDOWS_PLATFORM\s*\?\s*\{\s*icon: applicationIcon\(app\)\s*\}/
  )
  const windows = createWorkspaceWindowOptions({
    platform: 'win32',
    preload: 'preload.js',
    icon: 'windows.ico',
  })
  const mac = createWorkspaceWindowOptions({ platform: 'darwin', preload: 'preload.js' })
  assert.equal(windows.icon, 'windows.ico')
  assert.equal(windows.titleBarStyle, undefined)
  assert.equal(windows.titleBarOverlay, undefined)
  assert.equal(mac.titleBarStyle, 'hiddenInset')
  assert.equal(mac.titleBarOverlay, undefined)
  assert.doesNotMatch(mainSource, /titleBarOverlay/)
  assert.doesNotMatch(mainSource, /WINDOWS_TITLE_BAR_/)
})
