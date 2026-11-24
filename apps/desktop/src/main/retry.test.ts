import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { retryUpdate, transientUpdateFailure, UpdateTransportError } from './retry.ts'
import ts from 'typescript'
import { backgroundPreparationPolicy, UpdatePreparation } from './preparation.ts'
import type { PreparationCheckpoint } from './preparation.ts'
import { nextUpdateCheckAt } from './checks.ts'
import { isNewerRelease } from './version.ts'
import type { LatestVersionMeta, UpdateSnapshot } from '../updates.ts'

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const declarations: string[] = []
const handlers = ['scholarseed:update-check', 'scholarseed:update-start']
function visit(node: ts.Node): void {
  if (
    ts.isFunctionDeclaration(node) &&
    [
      'publishUpdateSnapshot',
      'installationBlocksUpdateCheck',
      'publishUpdateCheckResult',
      'armBackgroundUpdateCheck',
    ].includes(node.name?.text ?? '')
  )
    declarations.push(node.getText(source))
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'ipcMain.handle' &&
    ts.isStringLiteral(node.arguments[0]) &&
    handlers.includes(node.arguments[0].text)
  )
    declarations.push(node.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
assert.equal(declarations.length, 6)
const code = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const first = { id: 'first', version: '0.2.0', build_number: '202610152235' } as LatestVersionMeta
const newer = { ...first, id: 'newer', build_number: '202610160100' }

async function harness(platform: 'win32' | 'darwin' = 'win32') {
  const ipc = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  let prepares = 0
  const timers: number[] = []
  const platformPolicy = backgroundPreparationPolicy(platform)
  assert.ok(platformPolicy)
  const policy = { ...platformPolicy, coalesceMs: 0, intervalMs: 0 }
  const preparation = new UpdatePreparation(
    async () => {
      prepares++
      return true
    },
    undefined,
    policy
  )
  preparation.offer(first)
  await preparation.settled()
  const context = {
    MACOS_PLATFORM: 'darwin',
    updateStartupVerification: undefined as UpdateSnapshot['startupVerification'],
    latest: first,
    process: { platform },
    previewPolicyChanging: false,
    ipcMain: {
      handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => ipc.set(name, fn),
    },
    preparationPolicy: policy,
    lastPreparationDeferral: null,
    latestUpdateCandidate: null,
    withAnnouncedKey: (s: UpdateSnapshot) => s,
    sendToMainWindow: () => {},
    updateSnapshot: { phase: 'ready', currentVersion: '0.2.0', candidate: first } as UpdateSnapshot,
    currentUpdateSnapshot: (): UpdateSnapshot => context.updateSnapshot,
    updateInstallAbort: null as AbortController | null,
    updateRestartRequested: false,
    updateInstallationInProgress: false,
    macMaintenanceUncertain: false,
    desktopWorkbenchReady: () => true,
    requireDesktopWorkbench: () => {},
    app: { getVersion: () => '0.2.0', isPackaged: false },
    backgroundUpdateTimer: null,
    backgroundUpdateTimerStarted: true,
    backgroundUpdateTimerStopped: false,
    nextPeriodicUpdateCheckAt: Date.now() + 60_000,
    ACTIVE_UPDATE_CHECK_INTERVAL_MS: 60_000,
    updateCheckRetryAt: 0,
    nextUpdateCheckAt,
    clearTimeout: () => {},
    setTimeout: (_callback: () => void, delay: number) => {
      timers.push(delay)
      return { unref: () => {} }
    },
    pushLog: () => {},
    updatePreparation: preparation,
    nextPreparationRetryAt: 0,
    loadRendererPreferences: () => ({ autoDownloadUpdates: true }),
    isNewerRelease,
    updater: {
      isCurrentPreviewResult: () => true,
      previewPolicyRevision: () => 0,
      macHandoffCommitted: () => false,
      canPrepareMacSuccessor: () => false,
      macPreparationReady: () => true,
      updateLaneUnsupported: () => false,
      archType: () => 'windows-amd64',
      logUpdateEvent: () => {},
    },
    updateChecks: {
      isCurrent: () => true,
      run: async () => {
        throw new Error('check unavailable')
      },
    },
  }
  runInNewContext(code, context)
  const invoke = (name: string, ...args: unknown[]) =>
    ipc.get('scholarseed:update-' + name)!(null, ...args)
  const check = (latest = first) => {
    context.latest = latest
    return runInNewContext('publishUpdateCheckResult({has_update: true, latest})', context)
  }
  return {
    context,
    invoke,
    check,
    counts: () => ({ prepares }),
    schedule: () => runInNewContext('armBackgroundUpdateCheck()', context),
    timers,
  }
}

for (const enabled of [false, true]) {
  test(`a reserved macOS release keeps checking for newer builds (automatic=${enabled})`, async () => {
    const h = await harness('darwin')
    const { context } = h
    context.updater.macHandoffCommitted = () => true
    context.loadRendererPreferences = () => ({ autoDownloadUpdates: enabled })
    h.schedule()
    h.check(newer)
    assert.equal(h.timers.length, 0)
    assert.equal(context.updateSnapshot.latestCandidate, undefined)
    context.updater.canPrepareMacSuccessor = () => true
    h.schedule()
    assert.equal(h.timers.length, 1)
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const attempts: string[] = []
    context.updatePreparation = new UpdatePreparation(
      async ({ origin, candidate }) => {
        attempts.push(origin)
        await waiting
        if (enabled) context.updateSnapshot = { ...context.updateSnapshot, candidate }
        return enabled
      },
      undefined,
      context.preparationPolicy
    )
    h.check(newer)
    await Promise.resolve()
    assert.equal(context.updateSnapshot.phase, 'ready')
    assert.equal(context.updateSnapshot.candidate?.id, first.id)
    assert.equal(context.currentUpdateSnapshot().latestCandidate?.id, newer.id)
    assert.deepEqual(attempts, enabled ? ['background'] : [])
    let answered = false
    const response = h.invoke('start', newer.id).then((value) => {
      answered = true
      return value as { ok: boolean; errorFallback?: string }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(answered, false, 'accepting the request does not establish readiness')
    assert.deepEqual(attempts, [enabled ? 'background' : 'manual'])
    assert.equal(context.updateSnapshot.candidate?.id, first.id)
    finish()
    const result = await response
    assert.equal(result.ok, enabled)
    assert.equal(result.errorFallback, enabled ? undefined : 'preparation_failed')
    assert.equal(context.updateSnapshot.phase, 'ready')
    assert.equal(context.updateSnapshot.candidate?.id, enabled ? newer.id : first.id)
  })
}

test('a persisted archive limit projects the failure on the first cold update check', async () => {
  const h = await harness('darwin')
  let checkpoint: PreparationCheckpoint | null = null
  const persistence = {
    load: () => checkpoint,
    save: (value: PreparationCheckpoint) => {
      checkpoint = value
    },
    failed: (error: unknown) => {
      throw error
    },
  }
  const old = new UpdatePreparation(
    async () => 'archive-limit',
    persistence,
    backgroundPreparationPolicy('darwin')
  )
  old.offer(newer)
  await old.settled()
  h.context.updatePreparation = new UpdatePreparation(
    async () => {
      assert.fail('cold start must not prepare the rejected archive again')
    },
    persistence,
    backgroundPreparationPolicy('darwin')
  )
  h.context.updateSnapshot = { phase: 'idle', currentVersion: '0.2.0' }
  for (const enabled of [true, false]) {
    h.context.loadRendererPreferences = () => ({ autoDownloadUpdates: enabled })
    h.context.updateSnapshot = { phase: 'idle', currentVersion: '0.2.0' }
    h.check(newer)
    assert.equal(h.context.updateSnapshot.phase, 'failed')
    assert.equal(h.context.updateSnapshot.errorFallback, 'install_archive_limit')
    assert.equal(h.context.updateSnapshot.errorOrigin, 'preparation')
    h.context.updateSnapshot = { phase: 'ready', currentVersion: '0.2.0', candidate: first }
    h.check(newer)
    assert.equal(h.context.updateSnapshot.phase, 'ready')
    assert.equal(h.context.updateSnapshot.candidate?.id, first.id)
    assert.equal(h.context.updateSnapshot.latestCandidate, undefined)
  }
})

for (const platform of ['win32', 'darwin'] as const)
  test(`${platform} install rejection survives periodic and failed manual checks`, async () => {
    const h = await harness(platform)
    h.context.updateSnapshot = {
      ...h.context.updateSnapshot,
      phase: 'failed',
      errorOrigin: 'install',
      errorFallback: 'activation_unavailable',
    }
    for (let i = 0; i < 5; i++) h.check()
    await h.invoke('check')
    assert.equal(h.context.updateSnapshot.errorOrigin, 'install')
    assert.equal(h.context.updateSnapshot.errorFallback, 'activation_unavailable')
    assert.equal(h.counts().prepares, 1)
    h.check(newer)
    await h.context.updatePreparation.settled()
    assert.equal(h.counts().prepares, 2, 'safe failure must still allow a genuinely newer release')
  })

test('a new candidate consumes the previous success receipt before it is published', async () => {
  const { context } = await harness('darwin')
  context.updateStartupVerification = 'verified'
  runInNewContext(
    "publishUpdateSnapshot({ phase: 'up-to-date', currentVersion: '0.2.0' })",
    context
  )
  assert.equal(context.updateSnapshot.startupVerification, 'verified')

  runInNewContext(
    "publishUpdateSnapshot({ phase: 'available', currentVersion: '0.2.0', candidate: latest })",
    context
  )
  assert.equal(context.updateSnapshot.candidate?.id, first.id)
  assert.equal(context.updateSnapshot.announcedKey, undefined)
  assert.equal(context.updateSnapshot.startupVerification, undefined)

  runInNewContext(
    "publishUpdateSnapshot({ phase: 'up-to-date', currentVersion: '0.2.0' })",
    context
  )
  assert.equal(context.updateSnapshot.startupVerification, undefined)
})

test('native preparation never publishes a workbench-blocking restart, while quiescence does', async () => {
  const current = await harness('darwin')
  const controller = new AbortController()
  const context = current.context
  context.updateInstallAbort = controller
  runInNewContext("publishUpdateSnapshot({...updateSnapshot, phase: 'preparing'})", context)
  assert.equal(context.updateSnapshot.restartPending, false)
  assert.equal(context.updateSnapshot.restartPreparing, true)
  assert.equal(context.updateSnapshot.phase, 'preparing')
  runInNewContext("publishUpdateSnapshot({...updateSnapshot, phase: 'installing'})", context)
  assert.equal(context.updateSnapshot.restartPending, true)
  assert.equal(context.updateSnapshot.restartPreparing, false)
  controller.abort()
  runInNewContext("publishUpdateSnapshot({...updateSnapshot, phase: 'ready'})", context)
  assert.equal(context.updateSnapshot.restartPending, false)
})

test('expired preparation deadlines cannot spin the timer after install failure', async () => {
  const h = await harness('darwin')
  h.context.updateSnapshot = {
    ...h.context.updateSnapshot,
    errorOrigin: 'install',
    errorFallback: 'activation_unavailable',
  }
  h.context.updatePreparation.decision = () => ({ reason: 'failure-backoff', at: 1 })
  h.schedule()
  assert.equal(h.timers.length, 1)
  assert.ok(h.timers[0] > 50_000 && h.timers[0] <= 60_000)
})

test('only transport and sharing contention is transient, not trust, permissions or transactions', () => {
  for (const code of ['EBUSY', 'ECONNRESET', 'ETIMEDOUT'])
    assert.equal(transientUpdateFailure({ code }), true)
  for (const code of ['EACCES', 'EPERM', 'ESTALE', 'ERR_TERMINAL_RELEASE'])
    assert.equal(transientUpdateFailure({ code }), false)
  for (const status of [408, 429, 503])
    assert.equal(transientUpdateFailure(new UpdateTransportError(status)), true)
  for (const status of [401, 403, 404, 409])
    assert.equal(transientUpdateFailure(new UpdateTransportError(status)), false)
  assert.equal(transientUpdateFailure(new Error('signature invalid')), false)
  assert.equal(transientUpdateFailure(new DOMException('request timed out', 'TimeoutError')), true)
  assert.equal(transientUpdateFailure(new DOMException('cancelled', 'AbortError')), false)
})

test('retry is bounded, preserves cancellation and never retries nontransient errors', async () => {
  let calls = 0
  assert.equal(
    await retryUpdate(async () => {
      if (++calls === 1) throw new UpdateTransportError(503)
      return 'ok'
    }),
    'ok'
  )
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(
    retryUpdate(async () => {
      calls++
      throw new Error('binding changed')
    }),
    /binding/
  )
  assert.equal(calls, 1)
  const controller = new AbortController()
  calls = 0
  await assert.rejects(
    retryUpdate(async () => {
      calls++
      controller.abort()
      throw new UpdateTransportError(503)
    }, controller.signal)
  )
  assert.equal(calls, 1)
})

test('transient exhaustion stops after three attempts rather than extending indefinitely', async () => {
  let calls = 0
  await assert.rejects(
    retryUpdate(async () => {
      calls++
      throw new UpdateTransportError(503)
    }),
    /503/
  )
  assert.equal(calls, 3)
})
