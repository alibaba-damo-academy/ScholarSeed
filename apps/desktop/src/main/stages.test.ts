import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { InstallationProgress } from './installation.ts'
import { commitWithActivation, ActivationExpired } from './update-authorization.ts'
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
    get committed() {
      return committed
    },
    get ready() {
      return ready
    },
    prepare: async (_archive: unknown, _identity: unknown, authorize: Function) => {
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
    WINDOWS_PLATFORM: 'win32',
    InstallationProgress,
    commitWithActivation,
    retryUpdate,
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
  return { run, events, progress }
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
  assert.equal((await current.run()).ok, false)
  assert.equal(current.events.includes('quiesce-and-context'), false)
  assert.equal(current.events.includes('discard-context'), false)
  assert.ok(current.progress.every((value) => value.phase === 'preparing'))
})

test('failed final authorization consumes no launch context and cannot report handoff success', async () => {
  const current = fixture(false, true)
  assert.equal((await current.run()).ok, false)
  assert.equal(current.events.at(-1), 'discard-context')
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
          execPath: '/Applications/ScholarSeed.app/Contents/MacOS/ScholarSeed',
        },
        MACOS_PLATFORM: 'darwin',
        app: { isPackaged: true, getVersion: () => '0.3.1' },
        resolve,
        dirname,
        readSquirrelHandoff: () => handoff,
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
  for (const failure of ['none', 'transport', 'expired', 'binding', 'backend'] as const) {
    const exports: Record<string, Function> = {}
    const events: string[] = []
    let attempts = 0
    const archive = { sha512: 'digest', size: 1 }
    runInNewContext(
      ts.transpileModule(entry.getText(parsed), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        commitWithActivation,
        retryUpdate,
        AbortController,
        readReadyState: () => ({
          meta: { id: 'candidate', version: '0.3.1', build_number: '202611100001' },
          archive,
        }),
        authorizeActivation: async () => {
          attempts++
          events.push('grant')
          if (failure === 'transport' && attempts === 1) throw new UpdateTransportError(503)
          return () => {
            events.push('guard')
            if (failure === 'expired' && attempts === 1) throw new ActivationExpired()
          }
        },
        squirrel: {
          ready: true,
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
    if (failure === 'backend' || failure === 'binding') {
      await assert.rejects(run())
      assert.equal(events.includes('install'), false)
    } else {
      await run()
      assert.deepEqual(events.slice(-4), ['shutdown-barrier', 'guard', 'binding', 'install'])
      assert.equal(attempts, failure === 'none' ? 1 : 2)
    }
  }
})
