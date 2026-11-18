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
const declaration = parsed.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'installStagedUpdate'
)!

function fixture(failHelper = false, failFinalGrant = false) {
  const events: string[] = []
  const nativeSpaceChecks: boolean[] = []
  let ready = false
  let committed = false
  const exports: Record<string, Function> = {}
  const prepared = {
    receipt: {
      matches: () => true,
      revalidate: async () => {
        events.push('revalidate')
        return {}
      },
    },
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
    InstallationProgress,
    commitWithActivation,
    retryUpdate,
    assertSquirrelInstallSpace: (_archive: unknown, _expanded: number, nativePrepared: boolean) => {
      nativeSpaceChecks.push(nativePrepared)
      if (failFinalGrant && ready && !nativePrepared) throw new Error('ENOSPC')
    },
    readReadyState: () => staged,
    app: { getVersion: () => '0.3.1' },
    Date,
    macPrepared: prepared,
    squirrel: owner,
    macHandoffCommitted: () => committed,
    macHandoffReady: () => ready,
    logTiming: () => {},
    logUpdateEvent: () => {},
    persistUpdateLog: () => {},
    updateLog: undefined,
    discardOnTerminalSquirrelFailure: () => {},
    ActivationCandidateChanged: class extends Error {},
    PreparedArtifactChangedError: class extends Error {},
    UpdateVerifyError: class extends Error {},
    UpdateArchiveLimitError: class extends Error {},
  }
  runInNewContext(
    ts.transpileModule(declaration.getText(parsed), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    environment
  )
  let grants = 0
  const run = () =>
    exports.installStagedUpdate(
      (value: (typeof progress)[number]) => progress.push(value),
      () => {},
      undefined,
      async () => {
        events.push('grant')
        if (++grants === 2 && failFinalGrant) throw new Error('offline')
        return () => events.push('grant-guard')
      },
      async () => {
        assert.equal(ready, true)
        events.push('quiesce-and-context')
        return () => events.push('discard-context')
      }
    )
  return { run, events, progress, nativeSpaceChecks }
}

test('actual macOS install orchestration keeps helper preparation before quiescence and refreshes final authorization', async () => {
  const current = fixture()
  assert.equal((await current.run()).ok, true)
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
  const result = await current.run()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errorFallback, 'activation_recovery_required')
  assert.equal(current.events.includes('quiesce-and-context'), false)
  assert.equal(current.events.includes('discard-context'), false)
  assert.ok(current.progress.every((value) => value.phase === 'preparing'))
})

test('failed final authorization consumes no launch context and cannot report handoff success', async () => {
  const current = fixture(false, true)
  assert.equal((await current.run()).ok, false)
  assert.equal(current.events.at(-1), 'discard-context')
})

test('retry after authorization failure budgets only remaining space for a matching native preparation', async () => {
  const current = fixture(false, true)
  assert.equal((await current.run()).ok, false)
  assert.equal((await current.run()).ok, true)
  assert.deepEqual(current.nativeSpaceChecks, [false, true])
  assert.equal(current.events.filter((event) => event === 'helper').length, 1)

  const entry = parsed.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'assertSquirrelInstallSpace'
  )!
  const requirements: Array<[string, bigint]> = []
  const check = runInNewContext(
    ts.transpileModule(entry.getText(parsed) + '\nassertSquirrelInstallSpace', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      process: { execPath: '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed' },
      dirname,
      resolve,
      systemCacheDir: () => '/cache',
      statSync: () => ({ dev: 1 }),
      squirrelPreparedDevice: (candidate?: { dev: number }) => candidate?.dev,
      assertUpdateSpace: (path: string, bytes: bigint) => requirements.push([path, bytes]),
    }
  )
  check({ size: 40 }, 100, false)
  check({ size: 40 }, 100, true, { dev: 1 })
  assert.deepEqual(requirements, [['/cache', 240n]])
  check({ size: 40 }, 100, true, { dev: 2 })
  check({ size: 40 }, 100, true)
  assert.deepEqual(requirements, [
    ['/cache', 240n],
    ['/Applications/ScholarSeed.app', 100n],
    ['/Applications/ScholarSeed.app', 100n],
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
      macInstallPreparation: preparation,
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
        assertSquirrelInstallSpace: (
          selected: unknown,
          expanded: number,
          nativePrepared: boolean
        ) => {
          assert.equal(selected, archive)
          assert.equal(expanded, 100)
          assert.equal(nativePrepared, true)
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
