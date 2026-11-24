import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { InstallationProgress } from './installation.ts'
import {
  commitWithActivation,
  ActivationCandidateChanged,
  ActivationExpired,
} from './update-authorization.ts'
import { retryUpdate, UpdateTransportError } from './retry.ts'
import { dirname, resolve } from 'node:path'

const source = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('updater.ts', source, ts.ScriptTarget.Latest, true)
function updaterFunctions(names: string[]): string {
  return ts.transpileModule(
    parsed.statements
      .filter(
        (statement) =>
          ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? '')
      )
      .map((statement) => statement.getText(parsed))
      .join('\n'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
}

function fixture(failHelper = false, failFinalGrant = false, writable = true) {
  const events: string[] = []
  const nativeSpaceChecks: boolean[] = []
  let ready = false
  let committed = false
  const controller = new AbortController()
  const exports: Record<string, Function> = {}
  const prepared = {
    receipt: {
      matches: () => true,
      revalidate: async () => {
        events.push('revalidate')
        return staged.archive
      },
    },
  }
  let grants = 0
  const authorize = async () => {
    events.push('grant')
    if (++grants === 2 && failFinalGrant) throw new Error('offline')
    return () => events.push('grant-guard')
  }
  const owner = {
    preparedCandidate: () => undefined,
    matches: (
      _archive: unknown,
      identity: { candidate: string; buildNumber: string; version: string }
    ) =>
      ready &&
      identity.candidate === staged.meta.id &&
      identity.buildNumber === staged.meta.build_number &&
      identity.version === staged.meta.version,
    get committed() {
      return committed
    },
    get ready() {
      return ready
    },
    prepare: async (_archive: unknown, _identity: unknown, authorize: Function) => {
      if (ready) return
      events.push('helper')
      const guard = await authorize()
      guard()
      committed = true
      if (failHelper) throw new Error('native refused')
      ready = true
      events.push('ready')
    },
  }
  const staged = {
    meta: { id: 'candidate', version: '0.3.1', build_number: '202611100001' },
    archive: {},
  }
  const progress: { phase: string; installation?: { step: string } }[] = []
  const environment = {
    exports,
    process: { platform: 'darwin' },
    MACOS_PLATFORM: 'darwin',
    NO_STAGED_UPDATE: 'No staged update',
    InstallationProgress,
    commitWithActivation,
    retryUpdate,
    assertSquirrelPreparationSpace: () => {
      nativeSpaceChecks.push(false)
      if (failFinalGrant && ready) throw new Error('ENOSPC')
    },
    assertSquirrelInstallSpace: () => nativeSpaceChecks.push(true),
    readReadyState: () => staged,
    preparedIdentity: (meta: { id: string }) => meta.id,
    authorizeActivation: authorize,
    canPrepareMacUpdateWithoutInteraction: () => writable,
    app: { getVersion: () => '0.3.1' },
    Date,
    macPrepared: prepared,
    squirrel: owner,
    macLaunchCleanup: undefined,
    macHandoffCommitted: () => committed,
    macHandoffReady: () => ready,
    logTiming: () => {},
    logUpdateLine: () => {},
    logUpdateEvent: () => {},
    persistUpdateLog: () => {},
    updateLog: undefined,
    discardOnTerminalSquirrelFailure: () => {},
    ActivationCandidateChanged,
    PreparedArtifactChangedError: class extends Error {},
    UpdateVerifyError: class extends Error {},
    UpdateArchiveLimitError: class extends Error {},
  }
  runInNewContext(
    updaterFunctions([
      'prepareMacUpdate',
      'installStagedUpdate',
      'macArchiveReady',
      'macPreparationReady',
      'macNativePreparationMatches',
    ]),
    environment
  )
  const prepare = (allowInteraction = false) =>
    exports.prepareMacUpdate(
      staged.meta.id,
      (value: (typeof progress)[number]) => progress.push(value),
      () => {},
      controller.signal,
      undefined,
      allowInteraction
    )
  const install = () =>
    exports.installStagedUpdate(
      (value: (typeof progress)[number]) => progress.push(value),
      () => {},
      undefined,
      authorize,
      async () => {
        assert.equal(ready, true)
        events.push('quiesce-and-context')
        return () => events.push('discard-context')
      }
    )
  return { prepare, install, events, progress, nativeSpaceChecks }
}

test('background preparation proves native readiness before activation can quiesce writers', async () => {
  const current = fixture()
  assert.equal((await current.install()).ok, false)
  assert.deepEqual(current.events, [])
  assert.equal((await current.prepare()).ok, true)
  assert.deepEqual(current.events, ['revalidate', 'helper', 'grant', 'grant-guard', 'ready'])
  assert.equal((await current.install()).ok, true)
  assert.deepEqual(current.events, [
    'revalidate',
    'helper',
    'grant',
    'grant-guard',
    'ready',
    'quiesce-and-context',
    'grant',
    'grant-guard',
  ])
  assert.equal(
    current.progress.find((value) => value.installation?.step === 'helper')?.phase,
    'preparing'
  )
  assert.equal(
    current.progress.find((value) => value.installation?.step === 'saving')?.phase,
    'installing'
  )
  assert.ok(current.progress.every((value) => value.installation?.step !== 'restarting'))
})

test('native preparation refusal never quiesces product writers or persists a launch context', async () => {
  const current = fixture(true)
  const result = await current.prepare()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errorFallback, 'activation_recovery_required')
  assert.equal(current.events.includes('quiesce-and-context'), false)
  assert.equal(current.events.includes('discard-context'), false)
  assert.ok(current.progress.every((value) => value.phase === 'preparing'))
})

test('an unwritable installation needs explicit preparation before native side effects', async () => {
  const current = fixture(false, false, false)
  assert.equal((await current.prepare()).errorFallback, 'preparation_failed')
  assert.equal(current.events.length, 0)
  assert.equal((await current.prepare(true)).ok, true)
  assert.ok(current.events.includes('helper'))
  assert.equal(current.events.includes('quiesce-and-context'), false)
})

test('silent preparation checks the canonical application and its containing directory', () => {
  const writes: string[] = []
  let denied: string | undefined
  const writable = runInNewContext(
    updaterFunctions(['canPrepareMacUpdateWithoutInteraction']) +
      '\ncanPrepareMacUpdateWithoutInteraction',
    {
      process: { execPath: '/Alias.app/Contents/MacOS/ScholarSeed' },
      fsConstants: { W_OK: 2 },
      dirname,
      resolve,
      realpathSync: (path: string) => {
        assert.equal(path, '/Alias.app')
        return '/Applications/ScholarSeed.app'
      },
      accessSync: (path: string, mode: number) => {
        assert.equal(mode, 2)
        writes.push(path)
        if (path === denied) throw new Error('Permission denied')
      },
    }
  )
  assert.equal(writable(), true)
  assert.deepEqual(writes, ['/Applications/ScholarSeed.app', '/Applications'])
  for (const path of writes.slice()) {
    denied = path
    assert.equal(writable(), false)
  }
})

test('failed final authorization consumes no launch context and cannot report handoff success', async () => {
  const current = fixture(false, true)
  assert.equal((await current.prepare()).ok, true)
  assert.equal((await current.install()).ok, false)
  assert.equal(current.events.at(-1), 'discard-context')
})

test('retry after authorization failure budgets only remaining space for a matching native preparation', async () => {
  const current = fixture(false, true)
  assert.equal((await current.prepare()).ok, true)
  assert.equal((await current.install()).ok, false)
  assert.equal((await current.install()).ok, true)
  assert.deepEqual(current.nativeSpaceChecks, [false, true, true])
  assert.equal(current.events.filter((event) => event === 'helper').length, 1)
})

test('macOS preparation budgets cache, candidate and installation on their respective volumes', () => {
  const requirements: Array<[string, bigint]> = []
  const devices: Record<string, number> = { '/cache': 1, '/support': 1, '/Applications': 1 }
  const { prepare, install } = runInNewContext(
    updaterFunctions(['assertSquirrelPreparationSpace', 'assertSquirrelInstallSpace']) +
      '\n({ prepare: assertSquirrelPreparationSpace, install: assertSquirrelInstallSpace })',
    {
      process: { execPath: '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed' },
      app: { getPath: () => '/support' },
      dirname,
      resolve,
      systemCacheDir: () => '/cache',
      statSync: (path: string) => ({ dev: devices[path] }),
      squirrelPreparedDevice: (candidate?: { dev: number }) => candidate?.dev,
      assertUpdateSpace: (path: string, bytes: bigint) => requirements.push([path, bytes]),
    }
  )
  prepare({ size: 40 }, 100, false)
  install(100, { dev: 1 })
  assert.deepEqual(requirements.splice(0), [['/cache', 240n]])
  devices['/Applications'] = 2
  prepare({ size: 40 }, 100, false)
  assert.deepEqual(requirements.splice(0), [
    ['/cache', 240n],
    ['/Applications', 100n],
  ])
  devices['/support'] = 3
  prepare({ size: 40 }, 100, false)
  assert.deepEqual(requirements.splice(0), [
    ['/cache', 140n],
    ['/support', 100n],
    ['/Applications', 100n],
  ])
  prepare({ size: 40 }, 100, true)
  assert.deepEqual(requirements.splice(0), [
    ['/cache', 140n],
    ['/Applications', 100n],
  ])
  install(100, { dev: 3 })
  install(100)
  assert.deepEqual(requirements, [
    ['/Applications', 100n],
    ['/Applications', 100n],
  ])
})

test('normal quit cancels pre-handoff preparation and waits for its cleanup', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const index = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(index) === 'app.on' &&
      node.arguments[0]?.getText(index) === "'before-quit'"
    )
      callback = node.arguments[1]
    else ts.forEachChild(node, visit)
  }
  visit(index)
  assert.ok(callback)
  let finishPreparation!: () => void
  const preparation = new Promise<void>((resolve) => {
    finishPreparation = resolve
  })
  let finishQuit!: () => void
  const quit = new Promise<void>((resolve) => {
    finishQuit = resolve
  })
  const abort = new AbortController()
  const events: string[] = []
  abort.signal.addEventListener('abort', () => events.push('abort'), { once: true })
  const beforeQuit = runInNewContext(
    ts.transpileModule(`(${callback.getText(index)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      runtimePreparation: undefined,
      macInstallCommit: preparation,
      updateInstallAbort: abort,
      updater: { macHandoffCommitted: () => false },
      updateRestartRequested: false,
      updateInstallBlockingSince: null,
      updateInstallationInProgress: true,
      browserVaultIpc: undefined,
      browserVault: undefined,
      logWindowLifecycle: () => {},
      backendQuitFinished: false,
      backendQuitPending: false,
      backgroundUpdateTimerStopped: false,
      preferenceQuiescence: { prepare: () => events.push('preferences') },
      updatePreparation: { running: false },
      finishApplicationShutdown: () => events.push('shutdown'),
      setImmediate,
      app: { quit: finishQuit },
    }
  )
  beforeQuit({ preventDefault: () => events.push('prevent') })
  assert.deepEqual(events, ['abort', 'prevent'])
  events.push('cleanup')
  finishPreparation()
  await quit
  assert.deepEqual(events, ['abort', 'prevent', 'cleanup', 'preferences', 'shutdown'])
})

test('a newer independently opened App cannot acknowledge another or unbound installation transaction', async () => {
  const entry = parsed.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'macStartupAdmission'
  )!
  for (const target of [undefined, '/Applications/Other.app', '/Applications/ScholarSeed.app']) {
    const exports: Record<string, Function> = {}
    const handoff = { nativeRequest: target ? { target: { path: target } } : undefined }
    runInNewContext(
      ts.transpileModule(entry.getText(parsed), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        process: {
          platform: 'darwin',
          getuid: () => 501,
          execPath: '/Applications/Alias.app/Contents/MacOS/ScholarSeed',
        },
        MACOS_PLATFORM: 'darwin',
        app: { isPackaged: true, getVersion: () => '0.3.1' },
        resolve,
        dirname,
        realpathSync: (path: string) => {
          assert.equal(path, '/Applications/Alias.app')
          return '/Applications/ScholarSeed.app'
        },
        readSquirrelHandoff: () => handoff,
        TERMINAL_RECORD_LIMITS: { handoff: 4096 },
        captureRecord: () => ({ bytes: JSON.stringify(handoff) }),
        decodeSquirrelHandoff: JSON.parse,
        squirrelHandoffPath: () => '/home/squirrel.json',
        resolveDesktopConfig: () => ({ buildNumber: '202611100001' }),
        squirrelAdmission: () => 'allow',
        JSON,
      }
    )
    const result = await exports.macStartupAdmission('/home', () => {})
    assert.equal(result.admission, target === '/Applications/ScholarSeed.app' ? 'allow' : 'exit')
  }
})

test('native installation authorization is fresh after shutdown and rechecks exact candidate synchronously', async () => {
  const entry = parsed.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'quitMacUpdate'
  )!
  for (const failure of [
    'none',
    'transport',
    'expired',
    'binding',
    'backend',
    'disk',
    'conflict',
  ] as const) {
    const exports: Record<string, Function> = {}
    const events: string[] = []
    let attempts = 0
    let diskFull = failure === 'disk'
    const archive = { sha512: 'digest', size: 1 }
    runInNewContext(
      ts.transpileModule(entry.getText(parsed), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        commitWithActivation,
        ActivationCandidateChanged,
        persistRejectedUpdate: async () => {
          events.push('persist-rejection')
        },
        retryUpdate,
        AbortController,
        macPrepared: { receipt: { matches: () => true, expandedBytes: 100 } },
        assertSquirrelInstallSpace: (expanded: number) => {
          assert.equal(expanded, 100)
          events.push('disk-check')
          if (diskFull) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        },
        readReadyState: () => ({
          meta: { id: 'candidate', version: '0.3.1', build_number: '202611100001' },
          archive,
        }),
        authorizeActivation: async () => {
          attempts++
          events.push('grant')
          if (failure === 'conflict') throw new ActivationCandidateChanged('withdrawn')
          if (failure === 'transport' && attempts === 1) throw new UpdateTransportError(503)
          return () => {
            events.push('guard')
            if (failure === 'expired' && attempts === 1) throw new ActivationExpired()
          }
        },
        squirrel: {
          ready: true,
          preparedCandidate: () => undefined,
          matches: (selected: unknown, identity: { candidate: string }) => {
            assert.equal(selected, archive)
            assert.equal(identity.candidate, 'candidate')
            events.push('binding')
            return failure !== 'binding'
          },
          quitAndInstall: () => events.push('install'),
        },
      }
    )
    const run = () =>
      exports.quitMacUpdate(
        () => {},
        () => {
          events.push('shutdown-barrier')
          if (failure === 'backend') throw new Error('backend still active')
        }
      )
    if (failure === 'conflict') {
      await assert.rejects(run(), ActivationCandidateChanged)
      assert.deepEqual(events, ['grant', 'persist-rejection'])
    } else if (failure === 'backend' || failure === 'binding') {
      await assert.rejects(run())
      assert.equal(events.includes('install'), false)
    } else {
      if (failure === 'disk') {
        await assert.rejects(run(), { code: 'ENOSPC' })
        assert.equal(events.includes('install'), false)
        diskFull = false
      }
      await run()
      assert.deepEqual(events.slice(-5), [
        'shutdown-barrier',
        'binding',
        'disk-check',
        'guard',
        'install',
      ])
      assert.equal(attempts, failure === 'none' ? 1 : 2)
    }
  }
})
