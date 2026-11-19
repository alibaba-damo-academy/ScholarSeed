import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { readRecord, writeJson } from './journal.ts'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ActivationCandidateChanged } from './update-authorization.ts'
import { retryUpdate } from './retry.ts'
import { UpdatePreparation } from './preparation.ts'
import { acquireDirectoryWriter } from './writer.ts'
import type { LatestVersionMeta, UpdateSnapshot } from '../updates.ts'
import type * as Updater from './updater.ts'

interface RejectedFixtureExports {
  read: () => { id: string; revision: string } | null
  discardRejectedUpdate: typeof Updater.discardRejectedUpdate
  checkForUpdate: typeof Updater.checkForUpdate
}

// Real production functions at controlled native boundaries; not signed-package acceptance.
const source = ts.createSourceFile(
  'updater.ts',
  readFileSync(new URL('./updater.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
function functions(names: string[]): string {
  return ts.transpileModule(
    source.statements
      .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
      .map((node) => node.getText(source))
      .join('\n'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }
  ).outputText
}
const candidate = {
  id: 'withdrawn',
  version: '0.2.0',
  build_number: '202610211636',
} as LatestVersionMeta

for (const outcome of ['conflict', 'offline', 'cancelled'] as const)
  test(`macOS installation handles ${outcome} with a prepared native receipt`, async () => {
    const conflict = outcome === 'conflict'
    const controller = new AbortController()
    let authorizations = 0
    let discardedContext = false
    let ready: { meta: LatestVersionMeta; path: string; archive: object } | null = {
      meta: candidate,
      path: '/owned/update.dmg',
      archive: {},
    }
    let revoked = false
    const context = {
      retryUpdate,
      assertSquirrelInstallSpace: () => {},
      exports: {},
      process: { platform: 'darwin' },
      MACOS_PLATFORM: 'darwin',
      WINDOWS_PLATFORM: 'win32',
      readReadyState: () => ready,
      macHandoffReady: () => true,
      commitWithActivation: async (
        authorize: () => Promise<() => void>,
        commit: (guard: () => void) => void
      ) => commit(await authorize()),
      preparedIdentity: () => 'candidate',
      macPrepared: {
        receipt: {
          matches: () => true,
        },
      },
      signal: controller.signal,
      InstallationProgress: class {
        step() {}
        finish() {}
        dispose() {}
      },
      app: { getVersion: () => '0.2.0' },
      logTiming: () => {},
      logUpdateEvent: () => {},
      persistUpdateLog: () => {},
      updateLog: null,
      squirrel: { matches: () => true, preparedCandidate: () => undefined },
      macLaunchCleanup: undefined,
      ActivationCandidateChanged,
      discardRejectedUpdate: (selected: LatestVersionMeta) => {
        assert.equal(selected, candidate)
        revoked = true
        ready = null
      },
      authorize: async () => {
        authorizations++
        if (outcome === 'cancelled') {
          controller.abort()
          return () => {}
        }
        throw conflict ? new ActivationCandidateChanged('changed') : new Error('offline')
      },
      prepareLaunch: async () => () => {
        discardedContext = true
      },
    }
    runInNewContext(
      functions([
        'installStagedUpdate',
        'macPreparationReady',
        'macArchiveReady',
        'macNativePreparationMatches',
        'revokeMacCandidate',
      ]),
      context
    )
    const result = await runInNewContext(
      'exports.installStagedUpdate(() => {}, () => {}, signal, authorize, prepareLaunch)',
      context
    )
    assert.equal(result.ok, false)
    assert.equal(revoked, conflict)
    assert.equal(discardedContext, true)
    assert.equal(authorizations, 1)
    if (outcome === 'cancelled') {
      assert.equal(result.cancelled, true)
      assert.notEqual(ready, null)
    } else if (conflict) {
      assert.equal(result.errorFallback, 'activation_candidate_changed')
      assert.equal(result.error, undefined)
      assert.equal(ready, null)
    } else assert.match(result.error, /offline/)
  })

test('restart does not promote a disk candidate to ready before a fresh online check', () => {
  const context = {
    exports: {},
    process: { platform: 'darwin' },
    MACOS_PLATFORM: 'darwin',
    readSquirrelHandoff: () => null,
    squirrelHandoffPath: () => '',
    app: { getVersion: () => '0.2.0' },
    readReadyState: () => ({ meta: candidate }),
    resolveDesktopConfig: () => ({ buildNumber: '202610142032' }),
    isNewerRelease: () => true,
  }
  runInNewContext(functions(['initialUpdateSnapshot']), context)
  const snapshot = runInNewContext('exports.initialUpdateSnapshot(() => {})', context)
  assert.equal(snapshot.phase, 'idle')
  assert.equal(snapshot.candidate, undefined)
})

function diskHarness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'conflict-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let locked = false
  const context = {
    exports: {} as RejectedFixtureExports,
    join,
    dirname,
    rmSync,
    writeJson,
    randomUUID,
    retryUpdate,
    readRecord,
    updateStateDirectory: () => root,
    previewUpdatesEnabled: () => false,
    candidateStateDirectory: () => root,
    REJECTED_STATE_FILE: 'rejected.json',
    REJECTED_STATE_LIMIT: 4096,
    REJECTED_STATE_LOCK: 'rejected.lock',
    desktopDirectoryWriter: () => ({
      withRecordLock: (name: string, action: () => void) => {
        assert.equal(name, 'rejected.lock')
        assert.equal(locked, false)
        locked = true
        try {
          action()
        } finally {
          locked = false
        }
      },
      close() {},
    }),
    PREPARATION_STATE_FILE: 'preparation.json',
    validatedPreviewCandidates: new Map([[candidate.id, candidate]]),
    readReadyState: () => ({ meta: candidate }),
    dropStagedUpdate: () => rmSync(join(root, 'ready.json')),
    readPreparationCheckpoint: () => ({ desiredRelease: candidate }),
    logUpdateEvent: () => {},
  }
  runInNewContext(
    functions([
      'discardRejectedUpdate',
      'persistRejectedUpdate',
      'readRejectedUpdate',
      'rejectedUpdatePath',
      'withRejectedRecordLock',
    ]) + '\nexports.read = readRejectedUpdate;',
    context
  )
  writeFileSync(join(root, 'ready.json'), 'staged')
  writeFileSync(join(root, 'preparation.json'), 'checkpoint')
  writeFileSync(join(root, 'user-data'), 'keep')
  return { root, context, locked: () => locked }
}

test('a new rejection saved while a grant is in flight survives the old grant', async (t) => {
  const { root, context, locked } = diskHarness(t)
  const path = join(root, 'rejected.json')
  writeFileSync(path, JSON.stringify({ id: candidate.id, revision: 'old' }))
  const scope = {
    ...context,
    archType: () => 'darwin-arm64',
    resolveDesktopConfig: () => ({ baseUrl: 'https://update.example' }),
    app: { getVersion: () => '0.1.0' },
    previewRevision: 0,
    URL,
    buildUpdateCheckUrl: () => 'https://update.example/check',
    getJson: async () => ({}),
    parseUpdateCheckResult: () => ({ has_update: true, latest: candidate }),
    monotonicUpdateResult: (_version: unknown, _config: unknown, result: unknown) => result,
    AbortController,
    ActivationCandidateChanged,
    rmSync: (target: string) => {
      assert.equal(locked(), true)
      rmSync(target)
    },
    authorizeActivation: async () => {
      rmSync(join(root, 'preparation.json'), { force: true })
      await context.exports.discardRejectedUpdate(candidate, () => {})
      return () => assert.equal(locked(), true)
    },
  }
  const api = runInNewContext(
    functions([
      'checkForUpdate',
      'readRejectedUpdate',
      'rejectedUpdatePath',
      'withRejectedRecordLock',
    ]) + '\nexports.checkForUpdate',
    scope
  )
  await assert.rejects(
    api(() => {}),
    /rejection changed/
  )
  assert.notEqual(context.exports.read()?.revision, 'old')
  assert.equal(context.exports.read()?.id, candidate.id)
  scope.authorizeActivation = async () => () => assert.equal(locked(), true)
  await api(() => {})
  assert.equal(existsSync(path), false)
})

test('a new rejection waits for an in-progress clear before cleaning up', async (t) => {
  const { root, context } = diskHarness(t)
  const writer = context.desktopDirectoryWriter
  const path = join(root, 'rejected.json')
  writeFileSync(path, JSON.stringify({ id: candidate.id, revision: 'old' }))
  let busy = true
  let attempts = 0
  context.desktopDirectoryWriter = () => ({
    ...writer(),
    withRecordLock: (name, action) => {
      attempts++
      if (busy) throw Object.assign(new Error('record busy'), { code: 'ERR_LEASE_BUSY' })
      writer().withRecordLock(name, action)
    },
  })
  const pending = context.exports.discardRejectedUpdate(candidate, () => {})
  assert.equal(attempts, 1)
  assert.equal(existsSync(join(root, 'ready.json')), true)
  rmSync(path)
  busy = false
  await pending
  assert.equal(attempts, 2)
  assert.equal(context.exports.read()?.id, candidate.id)
  assert.equal(existsSync(join(root, 'ready.json')), false)
})

const nativeLibrary = process.env.SCHOLARSEED_LEASE_LIBRARY
test(
  'rejection persists after a competing native writer clears the old record',
  { skip: !nativeLibrary },
  async (t) => {
    const { root, context } = diskHarness(t)
    const native = createRequire(import.meta.url)(nativeLibrary!)
    const coordinator = mkdtempSync(join(tmpdir(), 'rejection-coordinator-'))
    t.after(() => rmSync(coordinator, { recursive: true, force: true }))
    context.desktopDirectoryWriter = () => acquireDirectoryWriter(native, coordinator, root)
    const path = join(root, 'rejected.json')
    writeFileSync(path, JSON.stringify({ id: candidate.id, revision: 'old' }))
    const pin = native.pin(root, false)
    const lock = native.acquireAt(pin, 'rejected.lock', true)
    let pending: Promise<void>
    try {
      pending = context.exports.discardRejectedUpdate(candidate, () => {})
      assert.equal(context.exports.read()?.revision, 'old')
      assert.equal(existsSync(join(root, 'ready.json')), true)
      rmSync(path)
    } finally {
      native.release(lock)
      native.release(pin)
    }
    await pending
    assert.equal(context.exports.read()?.id, candidate.id)
    assert.equal(existsSync(join(root, 'ready.json')), false)
  }
)

test('revocation persists before cleanup and survives a new process with unrelated files intact', async (t) => {
  const { root, context } = diskHarness(t)
  await context.exports.discardRejectedUpdate(candidate, () => {})
  assert.equal(existsSync(join(root, 'ready.json')), false)
  assert.equal(existsSync(join(root, 'preparation.json')), false)
  assert.equal(context.validatedPreviewCandidates.has(candidate.id), false)
  assert.equal(readFileSync(join(root, 'user-data'), 'utf8'), 'keep')
  const restarted = { ...context, exports: {} as Record<string, () => { id: string }> }
  runInNewContext(
    functions(['readRejectedUpdate', 'rejectedUpdatePath']) +
      '\nexports.read = readRejectedUpdate;',
    restarted
  )
  assert.equal(restarted.exports.read().id, candidate.id)
})

test('cleanup failure retains durable rejection and damaged records fail closed', async (t) => {
  const { root, context } = diskHarness(t)
  context.dropStagedUpdate = () => {
    throw new Error('locked')
  }
  await assert.rejects(
    context.exports.discardRejectedUpdate(candidate, () => {}),
    /locked/
  )
  assert.equal(context.exports.read()!.id, candidate.id)
  writeFileSync(join(root, 'rejected.json'), '{broken')
  assert.throws(() => context.exports.read())
})

for (const outcome of [
  'conflict',
  'offline',
  'authorized',
  'replacement',
  'withdrawn',
  'raced',
] as const)
  test(`fresh check of a rejected candidate: ${outcome}`, async (t) => {
    const { root, context } = diskHarness(t)
    await context.exports.discardRejectedUpdate(candidate, () => {})
    const next = { ...candidate, id: 'replacement' }
    let authorizations = 0
    const checks = {
      ...context,
      exports: {} as RejectedFixtureExports,
      AbortController,
      archType: () => 'darwin-arm64',
      resolveDesktopConfig: () => ({ baseUrl: 'https://example.test' }),
      app: { getVersion: () => '0.2.0' },
      previewUpdatesEnabled: () => false,
      previewRevision: 0,
      buildUpdateCheckUrl: () => 'https://example.test/check',
      URL,
      getJson: async () => ({
        has_update: outcome !== 'withdrawn',
        latest: outcome === 'withdrawn' ? null : outcome === 'replacement' ? next : candidate,
      }),
      parseUpdateCheckResult: (v: unknown) => v,
      monotonicUpdateResult: (_v: unknown, _c: unknown, result: unknown) => result,
      authorizeActivation: async () => {
        authorizations++
        if (outcome === 'conflict') throw new ActivationCandidateChanged('changed')
        if (outcome === 'offline') throw new Error('offline')
        if (outcome === 'raced')
          writeJson(join(root, 'rejected.json'), { id: candidate.id, revision: randomUUID() })
        return () => {}
      },
    }
    runInNewContext(
      functions(['checkForUpdate', 'readRejectedUpdate', 'rejectedUpdatePath']),
      checks
    )
    if (outcome === 'conflict' || outcome === 'offline' || outcome === 'raced') {
      await assert.rejects(checks.exports.checkForUpdate(() => {}))
      assert.equal(existsSync(join(root, 'rejected.json')), true)
    } else {
      const result = await checks.exports.checkForUpdate(() => {})
      assert.equal(
        result.latest?.id,
        outcome === 'replacement' ? next.id : outcome === 'withdrawn' ? undefined : candidate.id
      )
      assert.equal(existsSync(join(root, 'rejected.json')), outcome !== 'authorized')
    }
    assert.equal(authorizations, ['replacement', 'withdrawn'].includes(outcome) ? 0 : 1)
  })

test('conflict recovery clears the claimed preparation before requesting a fresh candidate', async () => {
  const prepared: string[] = []
  const preparation = new UpdatePreparation(async ({ candidate }) => {
    prepared.push(candidate.id)
    return true
  })
  preparation.offer(candidate)
  await preparation.settled()
  assert.equal(preparation.claim(candidate), true)
  preparation.release()
  let snapshot: UpdateSnapshot = { phase: 'ready', candidate, currentVersion: '0.2.0' }
  let checked = false
  const index = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const recovery = index.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'recoverUpdateConflict'
  )!
  const context = {
    updateChecks: { invalidate: () => {} },
    updatePreparation: preparation,
    updater: { macHandoffCommitted: () => false },
    publishUpdateSnapshot: (next: UpdateSnapshot) => {
      snapshot = next
    },
    app: { getVersion: () => '0.2.0' },
    windowsPrepared: {},
    latestUpdateCandidate: candidate,
    lastPreparationDeferral: 'old',
    nextPreparationRetryAt: 1,
    runBackgroundUpdateCheck: () => {
      checked = true
      assert.equal(snapshot.candidate, undefined)
      assert.equal(preparation.candidate, null)
      assert.equal(preparation.latest, null)
    },
  }
  runInNewContext(
    ts.transpileModule(recovery.getText(index), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
  await runInNewContext('recoverUpdateConflict()', context)
  assert.equal(checked, true)
  assert.equal(snapshot.errorFallback, 'activation_candidate_changed')
  assert.equal(context.windowsPrepared, null)
  assert.deepEqual(prepared, [candidate.id])
  // The rejected candidate must not retain a version barrier against the newly selected release.
  preparation.offer({ ...candidate, id: 'available', build_number: '202610201636' })
  await preparation.settled()
  assert.deepEqual(prepared, [candidate.id, 'available'])
})

test('a failed cold preparation cannot restore an unchecked disk candidate', () => {
  const index = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const declaration = index.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'retainedUpdateReady'
  )!
  let warm = false
  const ready = { meta: candidate }
  const context = {
    process: { platform: 'darwin' },
    MACOS_PLATFORM: 'darwin',
    pushLog: () => {},
    updater: {
      readReadyState: () => ready,
      previewCandidateValidated: () => true,
      macPreparationReady: () => warm,
    },
  }
  runInNewContext(
    ts.transpileModule(declaration.getText(index), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
  assert.equal(runInNewContext('retainedUpdateReady()', context), null)
  warm = true
  assert.equal(runInNewContext('retainedUpdateReady()', context), ready)
})
