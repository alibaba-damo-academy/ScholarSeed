import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const traySource = readFileSync(new URL('./tray.ts', import.meta.url), 'utf8')

function loadTray(options: { response?: number; checkboxChecked?: boolean } = {}) {
  const state = {
    quit: 0,
    trayMenu: [] as Array<{ label: string; click?: () => void }>,
    dialogs: 0
  }
  class FakeTray {
    handlers: Record<string, () => void> = {}
    constructor(_image: unknown) {}
    setToolTip(_tooltip: string): void {}
    setContextMenu(menu: Array<{ label: string; click?: () => void }>): void {
      state.trayMenu = menu
    }
    on(event: string, handler: () => void): void {
      this.handlers[event] = handler
    }
  }
  const dependencies: Record<string, unknown> = {
    electron: {
      app: {
        getPath: () => '/tmp/scholarseed',
        getAppPath: () => '/repo/apps/desktop',
        isPackaged: false,
        quit: () => { state.quit += 1 }
      },
      BrowserWindow: class {},
      Menu: { buildFromTemplate: (template: Array<{ label: string; click?: () => void }>) => template },
      Tray: FakeTray,
      dialog: {
        showMessageBox: async () => {
          state.dialogs += 1
          return { response: options.response ?? 0, checkboxChecked: options.checkboxChecked ?? false }
        }
      },
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => false }),
        createFromNamedImage: () => ({ isEmpty: () => false })
      }
    },
    fs: {
      existsSync: () => false,
      mkdirSync: () => undefined,
      readFileSync: () => '{}',
      renameSync: () => undefined,
      writeFileSync: () => undefined
    },
    path: { dirname, join }
  }
  const exports: Record<string, unknown> = {}
  const output = ts.transpileModule(traySource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(output, {
    exports,
    require: (name: string) => {
      assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name), `unexpected import: ${name}`)
      return dependencies[name]
    },
    process: { platform: 'win32', resourcesPath: '/resources' },
    JSON,
    Error
  })
  return { exports, state }
}

function fakeLocalizer() {
  return {
    getFixedT: () => (key: string) => key
  }
}

test('window close state is fail-open to asking before hiding to tray', () => {
  const { exports } = loadTray()
  const sanitize = exports.sanitizeWindowCloseState as (value: unknown) => { askOnClose: boolean }
  assert.equal(sanitize(undefined).askOnClose, true)
  assert.equal(sanitize({ askOnClose: false }).askOnClose, false)
  assert.equal(sanitize({ askOnClose: 'false' }).askOnClose, true)
})

test('Windows close confirmation can hide the window and persist do-not-ask', async () => {
  const { exports, state } = loadTray({ response: 0, checkboxChecked: true })
  const saved: unknown[] = []
  const hidden: string[] = []
  const prevented: string[] = []
  const create = exports.createWindowsCloseController as Function
  const controller = create({
    localizer: fakeLocalizer,
    revealWindow: () => true,
    markQuitting: () => undefined,
    log: () => undefined,
    platform: 'win32',
    stateStore: {
      load: () => ({ askOnClose: true }),
      save: (value: unknown) => saved.push(value)
    }
  })
  controller.handleClose(
    { hide: () => hidden.push('hide'), isDestroyed: () => false, isVisible: () => true },
    { preventDefault: () => prevented.push('prevent') }
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(prevented, ['prevent'])
  assert.deepEqual(hidden, ['hide'])
  assert.equal(saved.length, 1)
  assert.equal((saved[0] as { askOnClose: boolean }).askOnClose, false)
  assert.equal(state.dialogs, 1)
})

test('remembered Windows close preference hides without showing the dialog', () => {
  const { exports, state } = loadTray()
  const hidden: string[] = []
  const create = exports.createWindowsCloseController as Function
  const controller = create({
    localizer: fakeLocalizer,
    revealWindow: () => true,
    markQuitting: () => undefined,
    log: () => undefined,
    platform: 'win32',
    stateStore: {
      load: () => ({ askOnClose: false }),
      save: () => undefined
    }
  })
  controller.handleClose(
    { hide: () => hidden.push('hide'), isDestroyed: () => false, isVisible: () => true },
    { preventDefault: () => undefined }
  )
  assert.deepEqual(hidden, ['hide'])
  assert.equal(state.dialogs, 0)
})

test('tray quit menu marks the app as quitting before app quit', () => {
  const { exports, state } = loadTray()
  const marks: string[] = []
  const create = exports.createWindowsCloseController as Function
  const controller = create({
    localizer: fakeLocalizer,
    revealWindow: () => true,
    markQuitting: () => marks.push('quitting'),
    log: () => undefined,
    platform: 'win32',
    stateStore: {
      load: () => ({ askOnClose: false }),
      save: () => undefined
    }
  })
  controller.ensureTray({ isVisible: () => false })
  state.trayMenu.find(item => item.label === 'tray.quit')?.click?.()
  assert.deepEqual(marks, ['quitting'])
  assert.equal(state.quit, 1)
})
