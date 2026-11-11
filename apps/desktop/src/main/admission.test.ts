import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { squirrelLaunchSuperseded, settleSquirrelStartup } from './squirrelstartup.ts'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const entry = parsed.statements
  .find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'startDesktop'
  )!
  .getText(parsed)
const terminal = parsed.statements
  .find(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      statement.getText(parsed).startsWith('void startDesktop().catch')
  )!
  .getText(parsed)

async function launch(
  options: {
    observed?: boolean
    error?: string
    admission?: string | string[]
    status?: string
    platform?: string
    selectedHome?: string
  } = {}
) {
  const actions: string[] = []
  let admissionCall = 0
  const platform = options.platform ?? 'darwin'
  const context = {
    home: '/custom',
    userData: '/profile',
    workspace: '/projects',
    candidate: 'candidate',
    targetBuild: '202610220002',
  }
  const fail = (stage: string) => {
    actions.push(stage)
    if (options.error === stage) throw new Error(stage)
  }
  const scope = {
    process: {
      platform,
      resourcesPath: '/fixture.app/Contents/Resources',
      argv: [],
      env: {} as Record<string, string>,
    },
    app: {
      isPackaged: true,
      commandLine: {},
      getPath: () => '/fixture.app/Contents/MacOS/App',
      once: () => undefined,
      exit: (code: number) => {
        actions.push(`exit:${code}`)
      },
      setPath: () => {
        actions.push('restore-profile')
      },
    },
    startupAdmissionResolved: platform !== 'darwin',
    pendingUpdateLaunch: null,
    MacStartupAdmissionError: class extends Error {
      constructor(
        readonly status: string,
        cause?: unknown
      ) {
        super('Mac update startup admission is unresolved', { cause })
      }
    },
    recoveryErrors: [] as { status?: string }[],
    headless: false,
    UPDATE_REPAIR_WIZARD_ARGUMENT: '--repair-update',
    offerStartupRepair: async () => false,
    updateRepairTarget: () => null,
    recoverStartupAdmission: async (error: { status?: string }) => {
      scope.recoveryErrors.push(error)
      actions.push('recovery-surface')
    },
    MACOS_PLATFORM: 'darwin',
    pushLog: () => undefined,
    watchResourceDirectory: () => () => undefined,
    resolveProductConfig: () => ({
      bundleId: 'fixture',
      buildNumber: '202610220001',
      credentialProfile: { sessionNamespace: 'local' },
    }),
    observeUpdateLaunch: () => {
      fail('observe')
      return options.observed ? { context } : null
    },
    restoreUpdateLaunch: (...args: unknown[]) => {
      if (args[5] === 'superseded') actions.push('restore-superseded')
      fail('restore')
      return { context, complete: () => undefined }
    },
    restoreUpdateDebugPort: () => {
      actions.push('debug-port')
    },
    storageNative: {},
    coordinationRoot: () => '/coordination',
    userInfo: () => ({ uid: 501 }),
    applicationBundle: () => '/fixture.app',
    explicitUpdateProfile: () => undefined,
    SCHOLARSEED_HOME_ENV: 'HOME',
    SCHOLARSEED_DEFAULT_WORKSPACE_ENV: 'WORKSPACE',
    completeUpdateLaunch: undefined,
    updater: {
      macStartupAdmission: async (home: string, _log: unknown, expected: unknown) => {
        actions.push(`admission:${home}:${Boolean(expected)}`)
        return {
          admission: Array.isArray(options.admission)
            ? options.admission[admissionCall++]
            : (options.admission ?? 'allow'),
          status: options.status,
        }
      },
    },
    selectStorage: () => {
      fail('select')
      return { home: options.selectedHome ?? scope.process.env.HOME ?? '/default' }
    },
    coordinationReclamation: {
      run: () => {
        fail('reclamation')
        throw new Error('stop after admission')
      },
    },
    reportStartupFailure: () => {
      actions.push('failure-surface')
    },
    startupFailureTitle: () => 'failure',
    StorageConfigError: class extends Error {},
    storageFailureMessage: () => 'storage failure',
    Date,
  }
  runInNewContext(
    ts.transpileModule(entry + '\n' + terminal, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    scope
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  return { actions, scope }
}

for (const error of ['observe', 'restore', 'select']) {
  test(`actual entry shows isolated recovery when ${error} fails before admission completes`, async () => {
    const current = await launch({ error, observed: error === 'restore' })
    assert.equal(current.actions.at(-1), 'recovery-surface')
    assert.equal(current.actions.includes('failure-surface'), false)
    assert.equal(current.actions.includes('reclamation'), false)
    assert.equal(current.scope.startupAdmissionResolved, false)
  })
}

test('an unresolved custom transaction shows recovery before restore, default selection and product writes', async () => {
  const current = await launch({ observed: true, admission: 'exit' })
  assert.deepEqual(current.actions, ['observe', 'admission:/custom:true', 'recovery-surface'])
  assert.deepEqual(Object.keys(current.scope.process.env), [])
})

test('default-profile unresolved handoff shows recovery before product writes', async () => {
  const current = await launch({ admission: 'exit' })
  assert.deepEqual(current.actions, [
    'observe',
    'select',
    'admission:/default:false',
    'recovery-surface',
  ])
})

for (const observed of [false, true]) {
  for (const status of ['installing', 'restoring', 'unconfirmed']) {
    test(`actual ${observed ? 'custom' : 'default'} entry preserves ${status} refusal for nonblocking recovery`, async () => {
      const current = await launch({ observed, admission: 'exit', status })
      assert.equal(current.scope.recoveryErrors[0].status, status)
      assert.equal(current.actions.includes('restore-profile'), false)
      assert.equal(current.actions.includes('reclamation'), false)
      assert.equal(current.scope.startupAdmissionResolved, false)
    })
  }
}

test('a terminal custom transaction restores only after its context-bound admission and rechecks the selected home', async () => {
  const current = await launch({ observed: true, admission: 'failed' })
  assert.deepEqual(current.actions.slice(0, 7), [
    'observe',
    'admission:/custom:true',
    'restore',
    'debug-port',
    'restore-profile',
    'select',
    'admission:/custom:true',
  ])
  assert.equal(current.scope.startupAdmissionResolved, true)
})

test('Windows keeps ordinary storage selection without the macOS observation protocol', async () => {
  const current = await launch({ platform: 'win32' })
  assert.deepEqual(current.actions.slice(0, 3), [
    'select',
    'admission:/default:false',
    'reclamation',
  ])
  assert.equal(current.scope.startupAdmissionResolved, true)
})

test('the final context-bound check rejects changed handoffs with isolated recovery and without publishing storage', async () => {
  const current = await launch({ observed: true, admission: ['allow', 'exit'] })
  assert.equal(current.actions.at(-1), 'recovery-surface')
  assert.equal(current.actions.includes('admission:/custom:true'), true)
  assert.equal(current.actions.includes('reclamation'), false)
  assert.equal(current.actions.includes('failure-surface'), false)
})

test('selected storage cannot escape the observed custom profile between admission checks', async () => {
  const current = await launch({ observed: true, selectedHome: '/different' })
  assert.equal(current.actions.at(-1), 'recovery-surface')
  assert.equal(current.actions.includes('reclamation'), false)
  assert.equal(current.actions.includes('failure-surface'), false)
})

const updaterSource = readFileSync(new URL('./updater.ts', import.meta.url), 'utf8')
const updaterParsed = ts.createSourceFile('updater.ts', updaterSource, ts.ScriptTarget.Latest, true)
const admission = updaterParsed.statements
  .find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'macStartupAdmission'
  )!
  .getText(updaterParsed)
  .replace(/^export /, '')

async function probe(
  options: {
    initial?: Record<string, unknown> | null
    changed?: Record<string, unknown> | null
    superseded?: boolean
    idle?: boolean
  } = {}
) {
  const expected = {
    candidate: 'candidate',
    sourceBuild: '202610220001',
    targetBuild: '202610220002',
  }
  const record = {
    candidate: expected.candidate,
    buildNumber: expected.targetBuild,
    state: 'installing',
  }
  const initial = options.initial === undefined ? record : options.initial
  let reads = 0
  let inspected = false
  const scope = {
    process: { platform: 'darwin', execPath: '/fixture.app/Contents/MacOS/App' },
    MACOS_PLATFORM: 'darwin',
    app: { isPackaged: true, getVersion: () => '0.2.0' },
    readSquirrelHandoff: () =>
      ++reads === 1 ? initial : options.changed === undefined ? initial : options.changed,
    squirrelHandoffPath: (home: string) => home,
    resolveDesktopConfig: () => ({
      buildNumber: options.superseded ? '202610230001' : '202610220001',
      bundleId: 'fixture',
    }),
    squirrelAdmission: (_current: unknown, _handoff: unknown, status: string) =>
      options.superseded ? 'allow' : status === 'failed' ? 'failed' : 'exit',
    squirrelLaunchSuperseded,
    settleSquirrelStartup,
    inspectSquirrelIdle: async () => {
      inspected = true
      return options.idle !== false
    },
    inspectSquirrelStartup: async () => {
      inspected = true
      return 'failed'
    },
    systemCacheDir: () => '/cache',
    resolve: () => '/fixture.app',
    dirname: () => '/',
    JSON,
  }
  runInNewContext(
    ts.transpileModule(admission + '\nthis.admit = macStartupAdmission;', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    scope
  )
  const result = await (
    scope as typeof scope & {
      admit(home: string, log: () => void, expected: unknown): Promise<{ admission: string }>
    }
  ).admit('/custom', () => undefined, expected)
  return { result: result.admission, inspected }
}

test('superseded admission requires idle native state and unchanged matching handoff', async () => {
  assert.deepEqual(await probe({ superseded: true }), { result: 'superseded', inspected: true })
  for (const options of [
    { idle: false },
    { changed: null },
    { changed: { candidate: 'other', buildNumber: '202610220002' } },
  ]) {
    assert.equal((await probe({ superseded: true, ...options })).result, 'exit')
  }
  assert.equal((await probe({ superseded: true, initial: null })).result, 'exit')
})

test('superseded launch restores the original profile and repeats admission before publication', async () => {
  const current = await launch({ observed: true, admission: ['superseded', 'superseded'] })
  assert.equal(current.actions.includes('restore-superseded'), true)
  assert.equal(current.actions.filter((action) => action === 'admission:/custom:true').length, 2)
  assert.equal(current.scope.process.env.HOME, '/custom')
  assert.equal(current.scope.startupAdmissionResolved, true)
  const changed = await launch({ observed: true, admission: ['superseded', 'exit'] })
  assert.equal(changed.actions.includes('reclamation'), false)
  assert.equal(changed.scope.startupAdmissionResolved, false)
})

test('the actual updater gate refuses missing, replaced candidate and changed target-build evidence', async () => {
  for (const initial of [
    null,
    { candidate: 'other', buildNumber: '202610220002' },
    { candidate: 'candidate', buildNumber: 'older' },
  ]) {
    assert.deepEqual(await probe({ initial }), { result: 'exit', inspected: false })
  }
})

test('native probe completion cannot authorize a handoff replaced or changed while awaiting evidence', async () => {
  for (const changed of [
    null,
    { candidate: 'other', buildNumber: '202610220002', state: 'installing' },
    { candidate: 'candidate', buildNumber: '202610220002', state: 'downloaded' },
  ])
    assert.deepEqual(await probe({ changed }), { result: 'exit', inspected: true })
  assert.deepEqual(await probe(), { result: 'failed', inspected: true })
})
