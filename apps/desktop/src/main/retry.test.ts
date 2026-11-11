import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { retryUpdate, transientUpdateFailure, UpdateTransportError } from './retry.ts'
import ts from 'typescript'
import { MACOS_PREPARATION_POLICY, UpdatePreparation } from './preparation.ts'
import { nextUpdateCheckAt } from './checks.ts'
import type { LatestVersionMeta, UpdateSnapshot } from '../updates.ts'

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const declarations: string[] = []
const handlers = ['scholarseed:update-check']
function visit(node: ts.Node): void {
  if (
    ts.isFunctionDeclaration(node) &&
    ['publishUpdateSnapshot', 'publishUpdateCheckResult', 'armBackgroundUpdateCheck'].includes(
      node.name?.text ?? ''
    )
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
assert.equal(declarations.length, 4)
const code = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const first = { id: 'first', version: '0.2.0', build_number: '202610152235' } as LatestVersionMeta
const newer = { ...first, id: 'newer', build_number: '202610160100' }

async function harness(platform: 'win32' | 'darwin' = 'win32') {
  const ipc = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  let prepares = 0
  const timers: number[] = []
  const policy =
    platform === 'darwin'
      ? { ...MACOS_PREPARATION_POLICY, coalesceMs: 0, intervalMs: 0 }
      : undefined
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
    isNewerRelease: () => true,
    updater: {
      isCurrentPreviewResult: () => true,
      previewPolicyRevision: () => 0,
      macHandoffCommitted: () => false,
      macPreparationReady: () => true,
      updateLaneUnsupported: () => false,
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
  const invoke = (name: string) => ipc.get('scholarseed:update-' + name)!(null)
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

test('native preparation never publishes a workbench-blocking restart, while quiescence does', async () => {
  const current = await harness('darwin')
  const controller = new AbortController()
  const context = current.context
  context.updateInstallAbort = controller
  runInNewContext("publishUpdateSnapshot({...updateSnapshot, phase: 'preparing'})", context)
  assert.equal(context.updateSnapshot.restartPending, false)
  assert.equal(context.updateSnapshot.phase, 'preparing')
  runInNewContext("publishUpdateSnapshot({...updateSnapshot, phase: 'installing'})", context)
  assert.equal(context.updateSnapshot.restartPending, true)
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
