import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { PREVIEW_UPDATE_IPC } from '../updates.ts'
import type { LatestVersionMeta, PreviewUpdatePolicy, UpdateSnapshot } from '../updates.ts'
import { previewScope } from './preview.ts'
import { UpdatePreparation } from './preparation.ts'

const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const names = new Set([
  'requirePreviewSender',
  'requirePreviewPolicyChange',
  'resetPreviewCandidates',
  'changePreviewPolicy',
])
const declarations: string[] = []
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text || ''))
    declarations.push(node.getText(source))
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'ipcMain.handle' &&
    node.arguments[0].getText(source).startsWith('PREVIEW_UPDATE_IPC.')
  )
    declarations.push(node.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
assert.equal(declarations.length, 9)
const code = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
function candidate(version: string): LatestVersionMeta {
  return {
    id: version,
    version,
    build_number: '202610201000',
    channel: 'preview',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'darwin-arm64',
    file_size: 1,
    sha512: 'a'.repeat(128),
  }
}
function harness(preview = true) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const events: string[] = []
  const frame = {},
    sender = {}
  const target = candidate('0.3.0')
  let policy: PreviewUpdatePolicy = { scope: 'current-line' }
  let snapshot: UpdateSnapshot = { phase: 'idle', currentVersion: '0.2.0' }
  const preparation = new UpdatePreparation(async ({ candidate }) => {
    events.push(`prepare:${candidate.id}`)
    return true
  })
  const context = {
    updateRepairActive: false,
    PREVIEW_UPDATE_IPC,
    previewScope,
    updatePreparation: preparation,
    ipcMain: {
      handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) =>
        handlers.set(channel, handler),
    },
    requireDesktopWorkbench: () => {},
    isMainWindowSender: (s: unknown, f: unknown) => s === sender && f === frame,
    previewPolicyChanging: false,
    updateInstallAbort: null as AbortController | null,
    updateInstallationInProgress: false,
    updateRestartRequested: false,
    macMaintenanceUncertain: false,
    windowsPrepared: null,
    latestUpdateCandidate: null,
    lastPreparationDeferral: null,
    nextPreparationRetryAt: 0,
    updater: {
      previewUpdatesEnabled: () => preview,
      macHandoffCommitted: () => false,
      getPreviewUpdatePolicy: () => structuredClone(policy),
      writePreviewUpdatePolicy: (next: PreviewUpdatePolicy) => {
        events.push('persist')
        policy = structuredClone(next)
      },
      listPreviewUpdateLines: async () => [{ line: '0.3', latest: target }],
      previewTarget: (id: unknown) => {
        if (id !== target.id) throw new Error('not listed')
        return target
      },
      validatePreviewCandidate: async () => {
        events.push('validate')
      },
      discardPreviewPreparation: () => {
        events.push('discard')
      },
    },
    updateChecks: {
      invalidate: () => {
        events.push('invalidate-check')
      },
    },
    currentUpdateSnapshot: () => snapshot,
    publishUpdateSnapshot: (next: UpdateSnapshot) => {
      snapshot = next
      events.push(`snapshot:${next.phase}`)
      return next
    },
    app: { getVersion: () => '0.2.0' },
    pushLog: () => {},
    armBackgroundUpdateCheck: () => {},
    runBackgroundUpdateCheck: () => {
      events.push('check')
    },
  }
  runInNewContext(code, context)
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, ...args)
  return {
    context,
    handlers,
    events,
    call,
    policy: () => policy,
    snapshot: () => snapshot,
    preparation,
    target,
  }
}

test('preview IPC scope change clears a higher candidate and allows lower in-line repair', async () => {
  const h = harness()
  h.preparation.request(h.target)
  await h.preparation.settled()
  const result = await h.call(PREVIEW_UPDATE_IPC.scope, 'current-version')
  assert.equal(result.scope, 'current-version')
  assert.equal(h.preparation.candidate, null)
  assert.equal(h.snapshot().candidate, undefined)
  assert.ok(h.events.indexOf('persist') < h.events.indexOf('discard'))
  assert.equal(h.preparation.request(candidate('0.2.1')), true)
  await h.preparation.settled()
})

test('select starts only the chosen target; cancel drains it and preserves scope', async () => {
  const h = harness()
  await h.call(PREVIEW_UPDATE_IPC.scope, 'current-version')
  const selected = await h.call(PREVIEW_UPDATE_IPC.select, h.target.id)
  assert.equal(selected.target.id, h.target.id)
  await h.preparation.settled()
  assert.ok(h.events.includes(`prepare:${h.target.id}`))
  const cancelled = await h.call(PREVIEW_UPDATE_IPC.cancel)
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled)), { scope: 'current-version' })
  assert.equal(h.preparation.candidate, null)
})

test('unlisted IDs, release invocations, subframes and handoff reject without mutation', async () => {
  const h = harness()
  await assert.rejects(h.call(PREVIEW_UPDATE_IPC.select, 'arbitrary'), /not listed/)
  const invalid = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent
  await assert.rejects(
    h.handlers.get(PREVIEW_UPDATE_IPC.scope)!(invalid, 'current-version'),
    /sender/
  )
  assert.throws(() => h.handlers.get(PREVIEW_UPDATE_IPC.get)!(invalid), /sender/)
  h.context.updateInstallAbort = new AbortController()
  await assert.rejects(h.call(PREVIEW_UPDATE_IPC.cancel), /busy/)
  assert.equal(h.events.length, 0)
  const release = harness(false)
  await assert.rejects(release.call(PREVIEW_UPDATE_IPC.scope, 'current-version'), /unavailable/)
  assert.equal(release.events.length, 0)
})

test('server withdrawal after selection consumes the target and leaves no prepared permission', async () => {
  const h = harness()
  h.context.updater.validatePreviewCandidate = async () => {
    throw new Error('withdrawn')
  }
  await assert.rejects(h.call(PREVIEW_UPDATE_IPC.select, h.target.id), /withdrawn/)
  assert.equal(h.policy().target, undefined)
  assert.equal(h.preparation.candidate, null)
  assert.equal(h.snapshot().candidate, undefined)
  assert.equal(h.context.previewPolicyChanging, false)
})
