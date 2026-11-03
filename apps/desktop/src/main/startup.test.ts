import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { StartupScreen } from './startup.ts'

const source = readFileSync(new URL('./startup.ts', import.meta.url), 'utf8')

function fixture(platform = 'darwin', loadError?: Error, minimized = false, allowed = () => true) {
  const operations: string[] = []
  const scripts: string[] = []
  const timers = new Set<() => void>()
  let dismissed = 0
  let destroyed = false
  class FakeWindow extends EventEmitter {
    id = 1
    webContents = Object.assign(new EventEmitter(), {
      executeJavaScript: async (script: string) => {
        scripts.push(script)
      },
    })
    isDestroyed() {
      return destroyed
    }
    isVisible() {
      return operations.includes('show') && !destroyed
    }
    isMinimized() {
      return minimized
    }
    minimize() {
      minimized = true
    }
    restore() {
      minimized = false
      operations.push('restore')
    }
    setMenu() {}
    loadURL() {
      return loadError ? Promise.reject(loadError) : Promise.resolve()
    }
    show() {
      operations.push('show')
    }
    close() {
      operations.push('close')
      this.emit('close')
    }
    destroy() {
      destroyed = true
      this.emit('closed')
    }
  }
  let window: FakeWindow
  class WindowConstructor extends FakeWindow {
    constructor() {
      super()
      window = this
    }
  }
  const dependencies: Record<string, unknown> = {
    electron: { app: {}, BrowserWindow: WindowConstructor },
    './resources.ts': { applicationIcon: () => undefined },
    'node:fs': { readFileSync: () => Buffer.from('<svg/>') },
    '../renderer/src/assets/logo.svg?asset': { default: 'logo' },
    './localization': {
      mainLocalization: () => ({ language: 'zh', getFixedT: () => (key: string) => key }),
    },
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      Buffer,
      Date,
      Promise,
      process: { platform },
      require: (name: string) => {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected import: ${name}`)
        return dependencies[name]
      },
      setInterval: (callback: () => void) => {
        timers.add(callback)
        return callback
      },
      clearInterval: (callback: () => void) => {
        timers.delete(callback)
      },
    }
  )
  const create = exports.showStartupScreen as (
    visible?: () => void,
    dismiss?: () => void,
    log?: (line: string) => void,
    allowed?: () => boolean
  ) => StartupScreen
  const screen = create(
    undefined,
    () => {
      dismissed++
    },
    undefined,
    allowed
  )
  return { screen, window: window!, operations, scripts, timers, dismissed: () => dismissed }
}

test('close before load is terminal and resolves only after native closed', async () => {
  const current = fixture('win32')
  let resolved = false
  const completion = current.screen.close()
  void completion.then(() => {
    resolved = true
  })
  assert.equal(current.screen.close(), completion)
  current.window.webContents.emit('did-finish-load')
  current.screen.setStatus('late')
  assert.equal(current.screen.fail('error', 'late'), false)
  await Promise.resolve()
  assert.equal(resolved, false)
  assert.deepEqual(current.operations, ['close'])
  assert.equal(current.scripts.length, 0)
  assert.equal(current.timers.size, 0)
  current.window.destroy()
  await completion
  assert.equal(resolved, true)
  assert.equal(current.dismissed(), 0)
})

test('failure before load shows the cached error in the same window and stops progress', () => {
  const current = fixture('win32')
  assert.equal(current.screen.fail('failure title', 'failure detail'), true)
  current.screen.setStatus('late progress', 1)
  assert.equal(current.scripts.length, 0)
  assert.equal(current.timers.size, 0)
  current.window.webContents.emit('did-finish-load')
  assert.deepEqual(current.operations, ['show'])
  assert.match(current.scripts[0], /failure title/)
  assert.match(current.scripts[0], /failure detail/)
  assert.match(current.scripts[0], /toggleAttribute\("data-failed", true\)/)
  assert.doesNotMatch(current.scripts[0], /late progress/)
})

test('user close blocks late load and calls dismissal exactly once', async () => {
  const current = fixture()
  current.window.emit('close')
  current.window.webContents.emit('did-finish-load')
  assert.equal(current.screen.fail('failure', 'detail'), false)
  const completion = current.screen.close()
  current.window.destroy()
  current.window.emit('closed')
  await completion
  assert.equal(current.dismissed(), 1)
  assert.deepEqual(current.operations, [])
})

test('loaded failure stays visible without a second window or a modal call', async () => {
  const current = fixture()
  current.window.webContents.emit('did-finish-load')
  current.screen.fail('first failure', 'first detail')
  current.screen.fail('latest failure', 'latest detail')
  assert.match(current.scripts.at(-1)!, /latest failure/)
  const count = current.scripts.length
  const completion = current.screen.close()
  current.screen.setStatus('ignored')
  current.screen.fail('ignored', 'ignored')
  current.window.destroy()
  await completion
  assert.equal(current.scripts.length, count)
  assert.equal(current.dismissed(), 0)
})

test('a failed document load destroys the unusable window and stops its timer', async () => {
  const current = fixture('win32', new Error('load unavailable'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(current.window.isDestroyed(), true)
  assert.equal(current.timers.size, 0)
  assert.equal(current.dismissed(), 1)
  assert.equal(current.screen.fail('failure', 'detail'), false)
  await current.screen.close()
  current.window.webContents.emit('did-finish-load')
  assert.equal(current.operations.includes('show'), false)
})

test('an already queued elapsed callback cannot update a failed or closing window', async () => {
  const current = fixture('win32')
  current.window.webContents.emit('did-finish-load')
  const callback = [...current.timers][0]
  current.screen.fail('failure', 'detail')
  const count = current.scripts.length
  callback()
  const completion = current.screen.close()
  callback()
  current.window.destroy()
  await completion
  assert.equal(current.scripts.length, count)
})

test('failure restores a minimized startup surface instead of leaving the error inaccessible', () => {
  const current = fixture('win32', undefined, true)
  current.window.webContents.emit('did-finish-load')
  current.window.minimize()
  current.operations.length = 0
  current.screen.fail('failure', 'detail')
  assert.deepEqual(current.operations, ['restore', 'show'])
})

test('native loaded and failure callbacks recheck presentation admission and closed windows cannot be revived', async () => {
  let allowed = false
  const current = fixture('darwin', undefined, false, () => allowed)
  current.window.webContents.emit('did-finish-load')
  current.screen.fail('failure', 'detail')
  assert.deepEqual(current.operations, [])
  allowed = true
  assert.equal(current.screen.reveal(), true)
  assert.deepEqual(current.operations, ['show'])
  current.window.emit('close')
  assert.equal(current.screen.isClosing(), true)
  assert.equal(current.screen.reveal(), false)
  current.window.destroy()
  await current.screen.close()
  assert.equal(current.screen.reveal(), false)
})
