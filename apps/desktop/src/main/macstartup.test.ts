import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { SquirrelInstallation, readSquirrelHandoff, type SquirrelHandoff } from './squirrel.ts'
import {
  inspectSquirrelStartup,
  settleSquirrelStartup,
  squirrelAdmission,
  squirrelLaunchSuperseded,
} from './squirrelstartup.ts'
import { isNewerRelease } from './version.ts'
import { isPreviewUpdateChannel, type UpdateSnapshot } from '../updates.ts'
import type * as Updater from './updater.ts'
import type { DomainNative } from '../../native/domains.cjs'
import {
  observeUpdateLaunch,
  persistUpdateLaunch,
  restoreUpdateLaunch,
  type ObservedUpdateLaunch,
  type UpdateLaunchContext,
} from './relaunch.ts'

function functions(file: string, names: readonly string[]): string {
  const parsed = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const declarations = parsed.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? '')
  )
  assert.equal(declarations.length, names.length)
  return ts.transpileModule(declarations.map((statement) => statement.getText(parsed)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
}

const updaterCode = functions('./updater.ts', [
  'macStartupAdmission',
  'readAdmittedMacHandoff',
  'completeMacStartupAdmission',
  'initialUpdateSnapshot',
  'macHandoffCommitted',
  'previewUpdatesEnabled',
])
const bootstrapCode = functions('./index.ts', ['currentUpdateSnapshot', 'bootstrap'])
const MACOS_CONTEXT_FIXTURE_SKIP =
  process.platform !== 'darwin' &&
  'macOS persistent launch-context filesystem contract; not Windows product acceptance'

function indexExpression(select: (node: ts.CallExpression) => ts.Node | undefined): string {
  const parsed = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const matches: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const selected = select(node)
      if (selected) matches.push(selected)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(matches.length, 1)
  return matches[0].getText(parsed)
}

const readyCode = ts.transpileModule(
  indexExpression((node) =>
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'catch' &&
    node.getText().startsWith('app') &&
    node.getText().includes('.whenReady()') &&
    node.getText().includes('return bootstrap()')
      ? node
      : undefined
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText
const healthCode = ts.transpileModule(
  `exports.health = ${indexExpression((node) =>
    node.expression.getText() === 'ipcMain.handle' &&
    node.arguments[0]?.getText() === 'UPDATE_HEALTH_CHANNEL'
      ? node.arguments[1]
      : undefined
  )}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText

async function records(context: test.TestContext) {
  const home = realpathSync(await mkdtemp(join(tmpdir(), 'mac-startup-')))
  context.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'squirrel.json')
  const archive = join(home, 'application.zip')
  const bytes = Buffer.from('verified archive fixture')
  await writeFile(archive, bytes)
  let requested = ''
  const native = Object.assign(new EventEmitter(), {
    setFeedURL: () => undefined,
    checkForUpdates: () => {
      requested = readFileSync(path, 'utf8')
      native.emit('update-downloaded')
    },
    quitAndInstall: () => undefined,
  })
  const installation = new SquirrelInstallation(
    native,
    path,
    () => undefined,
    undefined,
    async (handoff) => {
      const capture = {
        path: '/fixture/source.app',
        parent: { dev: 1, ino: 2, uid: 501 },
        item: { dev: 1, ino: 3, uid: 501 },
      }
      return {
        source: capture,
        target: { ...capture, path: '/fixture/target.app' },
        binding: handoff.binding,
      }
    }
  )
  await installation.prepare(
    { path: archive, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') },
    {
      version: '0.3.2',
      buildNumber: '202611030002',
      candidate: 'candidate',
      at: Date.now(),
      state: 'requested',
    },
    async () => () => undefined
  )
  const downloaded = readFileSync(path, 'utf8')
  native.emit('error', new Error('native preparation failed'))
  const failed = readFileSync(path, 'utf8')
  return { home, path, states: { requested, downloaded, failed } }
}

function harness(home: string, recordPath: string, channel: string, platform = 'darwin') {
  const actions: string[] = []
  const failures: string[] = []
  const config = { buildNumber: '202611030001', bundleId: 'fixture', channel }
  let selectedHome = home
  const app = {
    isPackaged: true,
    getVersion: () => '0.3.1',
    on: () => undefined,
    exit: () => actions.push('exit'),
    whenReady: async () => undefined,
    setAsDefaultProtocolClient: () => true,
    isDefaultProtocolClient: () => true,
  }
  const exports = {} as Pick<
    typeof Updater,
    | 'macStartupAdmission'
    | 'completeMacStartupAdmission'
    | 'initialUpdateSnapshot'
    | 'macHandoffCommitted'
    | 'previewUpdatesEnabled'
  >
  const updaterScope = {
    exports,
    process: { platform, execPath: join(home, 'target.app/Contents/MacOS/App') },
    MACOS_PLATFORM: 'darwin',
    app,
    readSquirrelHandoff,
    squirrelHandoffPath: () => recordPath,
    desktopHome: () => selectedHome,
    resolveDesktopConfig: () => config,
    squirrelAdmission,
    squirrelLaunchSuperseded,
    settleSquirrelStartup,
    inspectSquirrelStartup,
    inspectSquirrelIdle: async () => true,
    systemCacheDir: () => home,
    resolve,
    dirname,
    isNewerRelease,
    isPreviewUpdateChannel,
    squirrel: null as { committed: boolean } | null,
    readReadyState: () => null,
    logUpdateEvent: () => undefined,
    rmSync: (path: string, options: Parameters<typeof rmSync>[1]) => {
      assert.equal(path, recordPath)
      actions.push('remove-handoff')
      rmSync(path, options)
    },
  }
  runInNewContext(updaterCode, updaterScope)
  const scope = {
    exports: {} as { bootstrap: () => Promise<void>; health: (event: unknown) => Promise<boolean> },
    app,
    process: { platform, env: {} },
    WINDOWS_PLATFORM: 'win32',
    updater: {
      ...exports,
      readAnnouncedKey: () => null,
      updateLaneUnsupported: () => false,
      syncMacUpdateDiagnostics: async () => undefined,
      macStartupStatus: async () =>
        inspectSquirrelStartup(readSquirrelHandoff(recordPath)!, home, 'fixture', home),
      pendingUpdateId: () => undefined,
      startMacDeferredCleanup: () => undefined,
    },
    updateSnapshot: null as UpdateSnapshot | null,
    updateAnnouncedKey: null,
    macStartupDecision: undefined as
      Awaited<ReturnType<typeof Updater.macStartupAdmission>> | undefined,
    withAnnouncedKey: (snapshot: UpdateSnapshot) => snapshot,
    pushLog: () => undefined,
    applyMainLanguage: async () => undefined,
    loadRendererPreferences: () => ({ language: 'en' }),
    mainLocalization: () => ({ getFixedT: () => (key: string) => key }),
    reportStartupFailure: (_title?: string, error?: string) => {
      actions.push('failure-surface')
      failures.push(error ?? '')
    },
    pendingUpdateLaunch: null as ObservedUpdateLaunch | null,
    completeUpdateLaunch: undefined as (() => void) | undefined,
    startupAdmissionResolved: true,
    headless: false,
    recoverStartupAdmission: async () => {
      actions.push('recovery-surface')
    },
    toastNative: undefined,
    installApplicationMenu: () => undefined,
    SCHOLARSEED_PROTOCOL: 'fixture',
    logWindowLifecycle: () => undefined,
    processIntegrityLevel: () => 'standard',
    startHandoffInboxDrain: () => actions.push('inbox'),
    connectDevelopmentControl: async () => {
      actions.push('development-control')
    },
    workbenchObservation: () => ({ currentBackend: {}, isCurrent: () => true }),
    workbenchHealth: {
      confirm: async (
        _backend: unknown,
        isCurrent: () => boolean,
        complete: (current: () => boolean) => Promise<void>
      ) => {
        await complete(isCurrent)
        return true
      },
    },
    coordinationReclamation: { run: () => undefined },
    ensureFreshAuth: () => undefined,
    backgroundUpdateCheckDeferred: false,
    pendingProtocolUrl: null,
    uncertainRelease: () => false,
    startupFailureTitle: () => 'failure',
    resolveStartupAccountBase: () => 'https://account.test',
    applicationRenderer: () => '/renderer',
    applicationExecutable: () => '/fixture.app/Contents/MacOS/App',
    serveAssets: async () => ({ url: 'http://fixture' }),
    appQuitting: false,
    openStartupScreen: () => actions.push('startup-screen'),
    startPreparedBackend: () => {
      actions.push('backend')
      throw new Error('stop after bootstrap admission')
    },
  }
  runInNewContext(bootstrapCode + '\nexports.bootstrap = bootstrap;\n' + healthCode, scope)
  return {
    actions,
    failures,
    config,
    scope,
    updaterScope,
    selectHome: (value: string) => {
      selectedHome = value
    },
    admit: async (expected?: Parameters<typeof Updater.macStartupAdmission>[2]) => {
      scope.macStartupDecision = await exports.macStartupAdmission(home, () => undefined, expected)
      return scope.macStartupDecision
    },
    snapshot: () => runInNewContext('currentUpdateSnapshot()', scope) as UpdateSnapshot,
    entry: async () => {
      await runInNewContext(readyCode, scope)
    },
    health: () => scope.exports.health({}),
    bootstrap: async () => {
      try {
        await scope.exports.bootstrap()
      } catch (error) {
        if ((error as Error).message !== 'stop after bootstrap admission') throw error
      }
    },
  }
}

async function restoredRecord(home: string, bytes: string) {
  const handoff = JSON.parse(bytes) as SquirrelHandoff
  const source = join(home, 'request', 'source.app')
  const target = join(home, 'target.app')
  const executable = join(
    target,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Resources',
    'ShipIt'
  )
  await mkdir(source, { recursive: true, mode: 0o700 })
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'native probe path')
  const capture = (path: string) => {
    const identity = (value: string) => {
      const info = lstatSync(value)
      return { dev: info.dev, ino: info.ino, uid: info.uid }
    }
    return { path, parent: identity(dirname(path)), item: identity(path) }
  }
  const nativeRequest = {
    source: capture(source),
    target: capture(target),
    binding: handoff.binding,
  }
  const cache = join(home, 'fixture.ShipIt')
  await mkdir(cache)
  await writeFile(
    join(cache, 'ShipItState.plist'),
    JSON.stringify({
      targetBundleURL: pathToFileURL(target).href,
      updateBundleURL: pathToFileURL(source).href,
    })
  )
  const acknowledgement = join(dirname(source), '.scholarseed-prepare.plist')
  await writeFile(
    acknowledgement,
    JSON.stringify({
      schema: 1,
      ready: false,
      code: 9,
      ...nativeRequest,
    }),
    { mode: 0o600 }
  )
  return {
    handoff: { ...handoff, state: 'installing' as const, nativeRequest },
    acknowledgement,
  }
}

function launchNative(): DomainNative {
  const pathOf = (pin: unknown) => (pin as { path: string }).path
  const identity = (path: string) => {
    const info = lstatSync(path)
    return `posix:${info.dev.toString(16).padStart(16, '0')}:${info.ino.toString(16).padStart(16, '0')}`
  }
  return {
    pin: (path, create) => {
      if (!existsSync(path)) {
        if (!create)
          throw Object.assign(new Error('missing fixture directory'), { code: 'ERR_LEASE_MISSING' })
        mkdirSync(path)
      }
      return { path }
    },
    lineage: (pin) => [identity(pathOf(pin))],
    persistentIdentity: (pin) => {
      const info = lstatSync(pathOf(pin))
      return `darwin:${'1'.repeat(32)}:${info.ino.toString(16).padStart(16, '0')}:${Math.floor(info.birthtimeMs).toString(16).padStart(16, '0')}:00000000`
    },
    createAt: (pin, name, bytes) => writeFileSync(join(pathOf(pin), name), bytes),
    createChild: (pin, name) => {
      const path = join(pathOf(pin), name)
      mkdirSync(path)
      return identity(path)
    },
    acquireAt: (pin, name) => ({ pin, name }),
    readAt: (pin, name, limit) => {
      const path = join(pathOf(pin), name)
      if (!existsSync(path)) return null
      const bytes = readFileSync(path)
      if (bytes.length > limit) throw new Error('fixture record exceeds limit')
      return bytes
    },
    listAt: (pin) =>
      Object.fromEntries(
        readdirSync(pathOf(pin)).map((name) => [name, readFileSync(join(pathOf(pin), name))])
      ),
    release: () => undefined,
  }
}

test('actual ready entry sends only final admission failures to native recovery', async (context) => {
  const fixture = await records(context)
  const startup = harness(fixture.home, fixture.path, 'release')
  await startup.admit()
  startup.scope.updater.syncMacUpdateDiagnostics = async () => {
    writeFileSync(fixture.path, fixture.states.downloaded)
  }
  await startup.entry()
  assert.ok(startup.actions.includes('recovery-surface'), JSON.stringify(startup.actions))
  assert.equal(startup.actions.includes('failure-surface'), false)
  assert.equal(startup.actions.includes('backend'), false)
  assert.equal(startup.actions.includes('inbox'), false)
  assert.equal(startup.actions.includes('development-control'), false)
  assert.equal(startup.scope.startupAdmissionResolved, false)
})

test('actual ready entry keeps backend failures on the ordinary failure surface', async (context) => {
  const fixture = await records(context)
  const startup = harness(fixture.home, fixture.path, 'release')
  await startup.admit()
  await startup.entry()
  assert.ok(startup.actions.includes('backend'), startup.failures.join('\n'))
  assert.ok(startup.actions.includes('failure-surface'))
  assert.equal(startup.actions.includes('recovery-surface'), false)
  assert.equal(startup.scope.startupAdmissionResolved, true)
})

async function sourceRecovery(context: test.TestContext) {
  const fixture = await records(context)
  const native = launchNative()
  const coordinator = join(fixture.home, 'coordination')
  const selection = {
    home: fixture.home,
    userData: join(fixture.home, 'profile'),
    workspace: join(fixture.home, 'workspace'),
  }
  await mkdir(selection.userData)
  await mkdir(selection.workspace)
  const identity = {
    uid: 501,
    application: join(fixture.home, 'target.app'),
    bundleId: 'fixture',
    build: '202611030001',
  }
  persistUpdateLaunch(native, coordinator, identity, selection, '202611030002', 'candidate')
  const observed = observeUpdateLaunch(native, coordinator, identity)!
  const restored = restoreUpdateLaunch(native, coordinator, identity, {}, observed)!
  restored.complete()
  assert.ok(observeUpdateLaunch(native, coordinator, identity))
  const startup = harness(fixture.home, fixture.path, 'release')
  startup.scope.pendingUpdateLaunch = observed
  startup.scope.completeUpdateLaunch = restored.complete
  const expected: NonNullable<Parameters<typeof Updater.macStartupAdmission>[2]> = observed.context
  const decision = await startup.admit(expected satisfies Readonly<UpdateLaunchContext>)
  assert.ok(decision?.evidence?.launch)
  assert.deepEqual(JSON.parse(decision.evidence.launch), observed.context)
  return { fixture, native, coordinator, identity, selection, observed, startup }
}

test(
  'failed source recovery retains its custom launch context until health, then permits a new candidate',
  { skip: MACOS_CONTEXT_FIXTURE_SKIP },
  async (context) => {
    const { fixture, native, coordinator, identity, selection, startup } =
      await sourceRecovery(context)
    await startup.bootstrap()
    assert.ok(observeUpdateLaunch(native, coordinator, identity))
    assert.throws(
      () =>
        persistUpdateLaunch(
          native,
          coordinator,
          identity,
          selection,
          '202611030003',
          'replacement'
        ),
      /already pending/
    )
    assert.equal(await startup.health(), true)
    assert.equal(observeUpdateLaunch(native, coordinator, identity), null)
    persistUpdateLaunch(native, coordinator, identity, selection, '202611030003', 'replacement')
    assert.equal(
      observeUpdateLaunch(native, coordinator, identity)?.context.candidate,
      'replacement'
    )
    assert.equal(readFileSync(fixture.path, 'utf8'), fixture.states.failed)
  }
)

for (const replaceHandle of [false, true]) {
  test(
    `final recovery rejects a replaced launch context with ${replaceHandle ? 'new' : 'original'} observation`,
    { skip: MACOS_CONTEXT_FIXTURE_SKIP },
    async (context) => {
      const { fixture, native, coordinator, identity, selection, observed, startup } =
        await sourceRecovery(context)
      observed.complete()
      persistUpdateLaunch(native, coordinator, identity, selection, '202611030003', 'replacement')
      if (replaceHandle)
        startup.scope.pendingUpdateLaunch = observeUpdateLaunch(native, coordinator, identity)
      await startup.entry()
      assert.ok(startup.actions.includes('recovery-surface'))
      assert.equal(startup.actions.includes('backend'), false)
      assert.equal(
        observeUpdateLaunch(native, coordinator, identity)?.context.candidate,
        'replacement'
      )
      assert.equal(readFileSync(fixture.path, 'utf8'), fixture.states.failed)
    }
  )
}

test(
  'a delayed readiness acknowledgement cannot consume a newer launch transaction',
  { skip: MACOS_CONTEXT_FIXTURE_SKIP },
  async (context) => {
    const { fixture, native, coordinator, identity, selection, observed, startup } =
      await sourceRecovery(context)
    await startup.bootstrap()
    observed.complete()
    persistUpdateLaunch(native, coordinator, identity, selection, '202611030003', 'replacement')
    assert.equal(await startup.health(), false)
    assert.equal(
      observeUpdateLaunch(native, coordinator, identity)?.context.candidate,
      'replacement'
    )
    assert.equal(readFileSync(fixture.path, 'utf8'), fixture.states.failed)
  }
)

test(
  'backend failure after safe source recovery preserves the custom context until real readiness',
  { skip: MACOS_CONTEXT_FIXTURE_SKIP },
  async (context) => {
    const { native, coordinator, identity, startup } = await sourceRecovery(context)
    await startup.entry()
    assert.ok(startup.actions.includes('backend'))
    assert.ok(startup.actions.includes('failure-surface'))
    assert.equal(startup.actions.includes('recovery-surface'), false)
    assert.equal(observeUpdateLaunch(native, coordinator, identity)?.context.candidate, 'candidate')
  }
)

for (const channel of ['release', 'preview']) {
  test(
    `${channel} admits an installing handoff only with native restored-target proof`,
    { skip: process.platform !== 'darwin' },
    async (context) => {
      const fixture = await records(context)
      const restored = await restoredRecord(fixture.home, fixture.states.downloaded)
      writeFileSync(fixture.path, JSON.stringify(restored.handoff))
      const startup = harness(fixture.home, fixture.path, channel)
      assert.equal((await startup.admit()).admission, 'failed')
      await startup.bootstrap()
      assert.ok(startup.actions.includes('backend'))
      assert.equal(startup.actions.includes('remove-handoff'), false)
    }
  )
}

test(
  'native restoration evidence revoked after admission cannot be reused by cached UI',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const fixture = await records(context)
    const restored = await restoredRecord(fixture.home, fixture.states.downloaded)
    writeFileSync(fixture.path, JSON.stringify(restored.handoff))
    const startup = harness(fixture.home, fixture.path, 'release')
    assert.equal((await startup.admit()).admission, 'failed')
    startup.snapshot()
    startup.scope.updater.syncMacUpdateDiagnostics = async () => {
      await rm(restored.acknowledgement)
    }
    await assert.rejects(startup.bootstrap(), /native restoration evidence/)
    assert.equal(startup.actions.includes('backend'), false)
  }
)

for (const mutation of ['handoff', 'missing', 'home', 'build', 'version'] as const) {
  test(`cached startup UI cannot hide ${mutation} changes during diagnostic synchronization`, async (context) => {
    const fixture = await records(context)
    const startup = harness(fixture.home, fixture.path, 'release')
    await startup.admit()
    startup.snapshot()
    startup.scope.updater.syncMacUpdateDiagnostics = async () => {
      if (mutation === 'handoff') writeFileSync(fixture.path, fixture.states.downloaded)
      if (mutation === 'missing') await rm(fixture.path)
      if (mutation === 'home') startup.selectHome(join(fixture.home, 'other'))
      if (mutation === 'build') startup.config.buildNumber = '202611030003'
      if (mutation === 'version') startup.updaterScope.app.getVersion = () => '0.3.2'
    }
    await assert.rejects(startup.bootstrap(), /admission evidence changed|launch context changed/)
    assert.equal(startup.actions.includes('backend'), false)
    assert.equal(startup.actions.includes('remove-handoff'), false)
  })
}

for (const channel of ['release', 'preview']) {
  for (const buildNumber of ['202611030002', '202611030003']) {
    test(`${channel} installed build ${buildNumber} reconciles only after cached UI and final admission`, async (context) => {
      const fixture = await records(context)
      const startup = harness(fixture.home, fixture.path, channel)
      startup.updaterScope.app.getVersion = () => '0.3.2'
      startup.config.buildNumber = buildNumber
      await startup.admit()
      assert.equal(startup.snapshot().phase, 'idle')
      assert.equal(startup.actions.includes('remove-handoff'), false)
      await startup.bootstrap()
      assert.ok(startup.actions.includes('backend'))
      assert.equal(startup.actions.filter((action) => action === 'remove-handoff').length, 1)
      assert.equal(existsSync(fixture.path), false)
    })
  }
}

for (const invalid of ['json', 'legacy', 'installing', 'version', 'build', 'binding'] as const) {
  test(`${invalid} evidence cannot reopen the source even with a failure-shaped record`, async (context) => {
    const fixture = await records(context)
    const handoff = JSON.parse(fixture.states.failed) as SquirrelHandoff
    if (invalid === 'legacy') delete handoff.binding
    if (invalid === 'installing') handoff.state = 'installing'
    if (invalid === 'version') handoff.version = 'unknown'
    if (invalid === 'build') handoff.buildNumber = 'unknown'
    if (invalid === 'binding') handoff.binding!.candidate = 'different'
    const bytes = invalid === 'json' ? '{' : JSON.stringify(handoff)
    writeFileSync(fixture.path, bytes)
    const startup = harness(fixture.home, fixture.path, 'release')
    assert.equal((await startup.admit()).admission, 'exit')
    await assert.rejects(startup.bootstrap())
    assert.equal(startup.actions.includes('backend'), false)
    assert.equal(startup.actions.includes('remove-handoff'), false)
    assert.equal(readFileSync(fixture.path, 'utf8'), bytes)
  })
}

test('packaged startup cannot reuse a snapshot without an admission receipt', async (context) => {
  const fixture = await records(context)
  const startup = harness(fixture.home, fixture.path, 'preview')
  await assert.rejects(startup.bootstrap(), /admission evidence changed or is unavailable/)
  assert.equal(startup.actions.includes('backend'), false)
})

test('only explicitly admitted outcomes can consume evidence or start the backend', async (context) => {
  const fixture = await records(context)
  for (const admission of ['exit', 'installing', 'restoring', 'unconfirmed']) {
    const startup = harness(fixture.home, fixture.path, 'release')
    const decision = await startup.admit()
    startup.scope.macStartupDecision = { ...decision, admission } as typeof decision
    await assert.rejects(startup.bootstrap(), /admission evidence changed or is unavailable/)
    assert.equal(startup.actions.includes('backend'), false)
    assert.equal(startup.actions.includes('remove-handoff'), false)
  }
})

test('snapshot errors never create or clear a live handoff commitment', async (context) => {
  const fixture = await records(context)
  for (const committed of [false, true]) {
    const startup = harness(fixture.home, fixture.path, 'release')
    startup.updaterScope.squirrel = committed ? { committed: true } : null
    assert.equal(startup.snapshot().errorFallback, 'activation_recovery_required')
    assert.equal(startup.scope.updater.macHandoffCommitted(), committed)
    await assert.rejects(startup.bootstrap(), /admission evidence changed or is unavailable/)
    assert.equal(startup.actions.includes('backend'), false)
  }
})

test('startup recovery never clears a live process handoff gate', async (context) => {
  const fixture = await records(context)
  const startup = harness(fixture.home, fixture.path, 'release')
  await startup.admit()
  startup.updaterScope.squirrel = { committed: true }
  await startup.bootstrap()
  assert.equal(startup.actions.includes('backend'), false)
  assert.equal(startup.actions.includes('failure-surface'), true)
  assert.equal(startup.updaterScope.squirrel.committed, true)
  assert.equal(readFileSync(fixture.path, 'utf8'), fixture.states.failed)
})

test('Windows bootstrap neither consumes nor interprets macOS recovery records', async (context) => {
  const fixture = await records(context)
  writeFileSync(fixture.path, '{')
  const startup = harness(fixture.home, fixture.path, 'release', 'win32')
  await startup.admit()
  await startup.bootstrap()
  assert.ok(startup.actions.includes('backend'))
  assert.equal(startup.scope.updateSnapshot?.phase, 'idle')
  assert.equal(readFileSync(fixture.path, 'utf8'), '{')
})

test('normal packaged startup admits an absent handoff without deleting other state', async (context) => {
  const fixture = await records(context)
  await rm(fixture.path)
  const startup = harness(fixture.home, fixture.path, 'release')
  await startup.admit()
  await startup.bootstrap()
  assert.ok(startup.actions.includes('backend'))
  assert.equal(startup.scope.updateSnapshot?.phase, 'idle')
  assert.equal(startup.actions.includes('remove-handoff'), false)
})

for (const channel of ['release', 'preview']) {
  for (const state of ['requested', 'downloaded', 'failed'] as const) {
    test(`${channel} boot consumes the admitted ${state} handoff without blocking the source`, async (context) => {
      const fixture = await records(context)
      writeFileSync(fixture.path, fixture.states[state])
      const startup = harness(fixture.home, fixture.path, channel)
      await startup.admit()
      await startup.bootstrap()
      assert.ok(startup.actions.includes('backend'), JSON.stringify(startup.actions))
      assert.equal(startup.scope.updateSnapshot?.errorFallback, 'install_failed')
      assert.equal(startup.actions.includes('remove-handoff'), false)
      assert.equal(readFileSync(fixture.path, 'utf8'), fixture.states[state])
    })
  }
}
