import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import type { ElectronApplication, JSHandle, Page, TestInfo } from '@playwright/test'
import type { RuntimePaths } from './runtime.ts'

const filename = fileURLToPath(new URL('./electron.ts', import.meta.url))
const compiled = transformSync(readFileSync(filename, 'utf8'), {
  loader: 'ts',
  format: 'cjs',
  target: 'node24',
})
const loaded = { exports: {} } as { exports: typeof import('./electron.ts') }
runInNewContext(
  compiled.code,
  {
    module: loaded,
    exports: loaded.exports,
    require: createRequire(filename),
    __dirname: dirname(filename),
    process,
    console,
    Buffer,
  },
  { filename }
)
const { DesktopSession } = loaded.exports

function fixture(value: unknown, evaluationError?: Error) {
  const runtime: RuntimePaths = {
    root: '',
    home: '',
    workspace: '',
    userData: '',
    drive: '',
    artifacts: process.cwd(),
  }
  const desktop = new DesktopSession(runtime, {} as TestInfo)
  const page = {} as Page
  let disposed = 0
  let evaluations = 0
  const handle = {
    async evaluate(callback: (value: unknown) => boolean) {
      evaluations += 1
      if (evaluationError) throw evaluationError
      return callback(value)
    },
    async dispose() {
      disposed += 1
    },
  } as unknown as JSHandle<Electron.BrowserWindow | null>
  desktop.app = {
    async browserWindow(candidate: Page) {
      assert.equal(candidate, page)
      return handle
    },
  } as unknown as ElectronApplication
  return { desktop, page, handle, disposed: () => disposed, evaluations: () => evaluations }
}

test('native window fixture rejects and releases a null BrowserWindow handle', async () => {
  const instance = fixture(null)
  await assert.rejects(
    instance.desktop.browserWindow(instance.page),
    /does not have a native BrowserWindow/
  )
  assert.equal(instance.evaluations(), 1)
  assert.equal(instance.disposed(), 1)
})

test('native window fixture returns the original handle only after checking its remote value', async () => {
  const instance = fixture({})
  assert.equal(await instance.desktop.browserWindow(instance.page), instance.handle)
  assert.equal(instance.evaluations(), 1)
  assert.equal(instance.disposed(), 0)
})

test('native window fixture releases a handle when remote validation fails', async () => {
  const failure = new Error('renderer target closed')
  const instance = fixture(null, failure)
  await assert.rejects(instance.desktop.browserWindow(instance.page), (error) => error === failure)
  assert.equal(instance.disposed(), 1)
})

test('native window fixture requires a launched Desktop application', async () => {
  const instance = fixture(null)
  instance.desktop.app = null
  await assert.rejects(instance.desktop.browserWindow(instance.page), /has not launched/)
  assert.equal(instance.evaluations(), 0)
  assert.equal(instance.disposed(), 0)
})
