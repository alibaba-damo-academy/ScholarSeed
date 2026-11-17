import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import ts from 'typescript'
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

function artifactFixture(context: { after: (cleanup: () => void) => void }, preserveRuntime = false) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-artifact-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = { root, home: join(root, 'home'), artifacts: join(root, 'artifacts'),
    workspace: join(root, 'workspace'), userData: join(root, 'user-data'), drive: join(root, 'drive') }
  Object.values(runtime).forEach(directory => mkdirSync(directory, { recursive: true }))
  const failure = new Error('artifact attachment failed')
  let closed = 0
  const desktop = new DesktopSession(runtime, {
    status: 'failed', expectedStatus: 'passed',
    attach: async () => { throw failure },
  } as unknown as TestInfo, { recordTrace: false, preserveRuntime })
  desktop.app = { close: async () => { closed++ } } as unknown as ElectronApplication
  writeFileSync(join(runtime.artifacts, 'desktop.log'), 'owned evidence')
  return { desktop, runtime, failure, closed: () => closed }
}

test('artifact attachment failure still removes only the owned runtime home', async context => {
  const instance = artifactFixture(context)
  await assert.rejects(instance.desktop.attachArtifacts(), error => error === instance.failure)
  assert.equal(instance.closed(), 1)
  assert.equal(existsSync(instance.runtime.home), false)
  assert.equal(existsSync(instance.runtime.artifacts), true)
  assert.equal(existsSync(instance.runtime.userData), true)
})

test('artifact attachment failure preserves a runtime explicitly retained for diagnosis', async context => {
  const instance = artifactFixture(context, true)
  await assert.rejects(instance.desktop.attachArtifacts(), error => error === instance.failure)
  assert.equal(instance.closed(), 1)
  assert.equal(existsSync(instance.runtime.home), true)
})

function authenticationFixture(context: { after: (cleanup: () => void) => void }, phase: string,
  attachmentFailure = false) {
  const instance = artifactFixture(context)
  writeFileSync(join(instance.runtime.userData, 'renderer-preferences.json'), '{}')
  const original = new Error(`${phase} failed`)
  let created = 0
  let closed = 0
  let attached = 0
  let screenshots = 0
  const page = {
    url: () => 'http://127.0.0.1:1234',
    route: async () => { if (phase === 'route') throw original },
    screenshot: async () => { screenshots++ },
  } as unknown as Page
  const spec = readFileSync(new URL('../auth.spec.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('auth.spec.ts', spec, ts.ScriptTarget.Latest, true)
  let body = ''
  let descriptions = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'test.describe' &&
        node.arguments[0]?.getText(parsed) === "'authenticated'") {
      const callback = node.arguments[1] as ts.ArrowFunction
      body = callback.body.getText(parsed).slice(1, -1)
      descriptions++
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.ok(body)
  assert.equal(descriptions, 1)
  const cases: Array<(args: object, info: TestInfo) => Promise<void>> = []
  const titles: string[] = []
  const environment: Record<string, string | undefined> = {}
  const fixtureInfo = {
    status: 'passed', expectedStatus: 'passed',
    attach: async () => { attached++; if (attachmentFailure) throw instance.failure },
  } as unknown as TestInfo
  runInNewContext(transformSync(body, { loader: 'ts' }).code, {
    test: (title: string, callback: (args: object, info: TestInfo) => Promise<void>) => {
      titles.push(title)
      cases.push(callback)
    },
    createRuntime: () => instance.runtime,
    DesktopSession: class extends DesktopSession {
      constructor(runtime: RuntimePaths, info: TestInfo) {
        super(runtime, info, { recordTrace: false })
        created++
      }
      async launch() {
        this.app = { close: async () => { closed++ } } as unknown as ElectronApplication
        if (phase === 'launch') throw original
        this.page = page
        return page
      }
    },
    join, writeFileSync,
    readFileSync: (...args: Parameters<typeof readFileSync>) => {
      if (phase === 'preferences') throw original
      return readFileSync(...args)
    },
    PREFERENCES_FILE: 'renderer-preferences.json', ONBOARDING_GROUPS: ['welcome'],
    ACCOUNT_BASE_ENV: 'SCHOLARSEED_ACCOUNT_BASE_URL', UNREACHABLE_ACCOUNT_BASE: 'http://127.0.0.1:9',
    process: { env: environment }, URL,
    seedAuthTokens: async () => { if (phase === 'seed') throw original },
    mockAccountApi: async () => { if (phase === 'mock') throw original; return {} },
    authStatusPayload: () => ({}),
    adoptSeededAuth: async () => { throw original },
  })
  assert.equal(cases.length, 6)
  assert.equal(titles[0], 'landing page auto-dismisses')
  return { ...instance, original, environment, created: () => created, closed: () => closed,
    attached: () => attached, screenshots: () => screenshots, run: () => cases[0]({}, fixtureInfo) }
}

for (const phase of ['preferences', 'seed', 'launch', 'mock', 'route', 'adoption']) {
  test(`authenticated ${phase} failure closes its owned Desktop and removes its home`, async context => {
    const instance = authenticationFixture(context, phase)
    await assert.rejects(instance.run(), error => error === instance.original)
    assert.equal(instance.created(), 1)
    assert.equal(instance.closed(), ['preferences', 'seed'].includes(phase) ? 0 : 1)
    assert.equal(instance.attached(), 1)
    assert.equal(instance.screenshots(), ['preferences', 'seed', 'launch'].includes(phase) ? 0 : 1)
    assert.equal(existsSync(instance.runtime.home), false)
    assert.equal(Object.hasOwn(instance.environment, 'SCHOLARSEED_ACCOUNT_BASE_URL'), false)
  })
}

test('authenticated primary and attachment failures both remain observable', async context => {
  const instance = authenticationFixture(context, 'adoption', true)
  await assert.rejects(instance.run(), (error: unknown) => {
    const errors = (error as AggregateError).errors
    assert.ok(Array.isArray(errors))
    assert.equal(errors[0], instance.original)
    assert.equal(errors[1], instance.failure)
    return true
  })
  assert.equal(instance.closed(), 1)
  assert.equal(existsSync(instance.runtime.home), false)
})

for (const previous of [undefined, '', 'http://127.0.0.1:4321']) {
  for (const phase of ['launch', 'adoption']) {
    test(`authenticated ${phase} restores the prior account environment ${JSON.stringify(previous)}`, async context => {
      const instance = authenticationFixture(context, phase)
      if (previous !== undefined) instance.environment.SCHOLARSEED_ACCOUNT_BASE_URL = previous
      await assert.rejects(instance.run(), error => error === instance.original)
      assert.equal(instance.environment.SCHOLARSEED_ACCOUNT_BASE_URL, previous)
      assert.equal(Object.hasOwn(instance.environment, 'SCHOLARSEED_ACCOUNT_BASE_URL'), previous !== undefined)
    })
  }
}
