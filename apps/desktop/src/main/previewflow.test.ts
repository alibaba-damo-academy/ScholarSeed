import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as preview from './preview.ts'
import { isPreviewUpdateChannel } from '../updates.ts'
import {
  buildUpdateCheckUrl,
  parseDownloadInfo,
  parseUpdateCheckResult,
  UPDATE_PATH_PREFIX,
} from './release.ts'
import { isNewerRelease } from './version.ts'
import type { LatestVersionMeta, PreviewUpdatePolicy } from '../updates.ts'
import type * as Updater from './updater.ts'

type PreviewFixtureExports = Pick<
  typeof Updater,
  | 'checkForUpdate'
  | 'getDownloadInfo'
  | 'getPreviewUpdatePolicy'
  | 'isCurrentPreviewResult'
  | 'listPreviewUpdateLines'
  | 'previewCandidateValidated'
  | 'previewTarget'
  | 'validatePreviewCandidate'
  | 'writePreviewUpdatePolicy'
>

// Execute the real updater functions with controlled HTTP/storage boundaries.
// These are protocol integration tests, not signed installation acceptance.
const file = ts.createSourceFile(
  'updater.ts',
  readFileSync(new URL('./updater.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const names = new Set([
  'previewUpdatesEnabled',
  'previewSource',
  'getPreviewUpdatePolicy',
  'writePreviewUpdatePolicy',
  'previewCandidateAllowed',
  'previewPolicyRevision',
  'isCurrentPreviewResult',
  'currentPreviewContext',
  'listPreviewUpdateLines',
  'previewTarget',
  'validatePreviewCandidate',
  'previewCandidateValidated',
  'monotonicUpdateResult',
  'checkForUpdate',
  'getDownloadInfo',
  'readRejectedUpdate',
  'rejectedUpdatePath',
  'candidateStateDirectory',
  'authorizeActivation',
])
const constants = new Set([
  'PREVIEW_CANDIDATE_DIRNAME',
  'REJECTED_STATE_FILE',
  'REJECTED_STATE_LIMIT',
])
const declarations = file.statements
  .filter(
    (statement) =>
      (ts.isFunctionDeclaration(statement) && names.has(statement.name?.text || '')) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((declaration) =>
          constants.has(declaration.name.getText(file))
        ))
  )
  .map((statement) => statement.getText(file))
assert.equal(declarations.length, names.size + constants.size)
const code = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function artifact(version = '0.2.1', channel = 'preview'): LatestVersionMeta {
  return {
    id: `${channel}-${version}`,
    version,
    build_number: '202610201001',
    channel,
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'darwin-arm64',
    team_id: 'TEAM',
    file_size: 100,
    sha512: 'a'.repeat(128),
  }
}
function harness(channel = 'preview', stored?: unknown) {
  const requests: URL[] = []
  const writes: unknown[] = []
  let response: unknown = { has_update: false, latest: null }
  let responder: (() => Promise<unknown>) | undefined
  const config = {
    baseUrl: 'https://updates.example',
    channel,
    buildNumber: '202610201000',
    productId: 'scholarseed',
    bundleId: 'com.scholarseed.desktop',
    expectedTeamId: 'TEAM',
    expectedWindowsPublisher: '',
    releaseLane: 'distribution',
  }
  let reads = 0
  let rejectedReads = 0
  let rejected: unknown
  const context = {
    ...preview,
    structuredClone,
    AbortController,
    isPreviewUpdateChannel,
    isNewerRelease,
    URL,
    join,
    parseDownloadInfo,
    parseUpdateCheckResult,
    buildUpdateCheckUrl,
    UPDATE_PATH_PREFIX,
    exports: {} as PreviewFixtureExports,
    previewPolicy: null as PreviewUpdatePolicy | null,
    previewRevision: 0,
    previewLines: [],
    validatedPreviewCandidates: new Map(),
    readRejectedUpdate: () => null,
    resolveDesktopConfig: () => config,
    resolveProductConfig: () => ({ updateActivationKeys: {} }),
    archType: () => 'darwin-arm64',
    app: { getVersion: () => '0.2.0' },
    updateStateDirectory: () => '/owned/updates',
    desktopDirectoryWriter: () => ({ close() {} }),
    writeJson: (_path: string, value: unknown) => {
      stored = value
      writes.push(value)
    },
    readRecord: (path: string) => {
      if (path.endsWith('rejected.json')) {
        rejectedReads++
        if (rejected !== undefined) return Buffer.from(JSON.stringify(rejected))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      assert.ok(path.endsWith(preview.PREVIEW_STATE_FILE))
      reads++
      if (stored === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return Buffer.from(JSON.stringify(stored))
    },
    getJson: async (url: string) => {
      requests.push(new URL(url))
      return responder ? responder() : response
    },
  }
  runInNewContext(code, context)
  return {
    context,
    requests,
    writes,
    reads: () => reads,
    rejectedReads: () => rejectedReads,
    reject: (value: unknown) => {
      rejected = value
    },
    api: context.exports,
    response: (value: unknown) => {
      response = value
    },
    responder: (value: () => Promise<unknown>) => {
      responder = value
    },
  }
}
const log = () => {}

test('candidate rejection records fail closed before an update response can restore admission', async () => {
  const h = harness()
  const candidate = artifact()
  h.response({ has_update: true, latest: candidate })
  for (const record of [{}, { id: candidate.id, revision: '' }, { id: '', revision: 'revision' }]) {
    h.reject(record)
    await assert.rejects(h.api.checkForUpdate(log), /Invalid rejected update record/)
  }
  h.reject({ id: candidate.id, revision: 'revision' })
  await assert.rejects(h.api.checkForUpdate(log), /activation trust roots are not configured/)
  assert.equal(h.rejectedReads(), 4)
  assert.equal(h.requests.length, 4)
  assert.equal(h.writes.length, 0)
})

test('release request and cache behavior do not consume preview controls', async () => {
  const h = harness('release', { broken: true })
  h.response({ has_update: true, latest: artifact('0.3.0', 'release') })
  const result = await h.api.checkForUpdate(log)
  assert.equal(result.latest!.version, '0.3.0')
  assert.equal(result.previewRevision, undefined)
  assert.equal(h.requests[0].searchParams.has('preview_scope'), false)
  assert.equal(h.reads(), 0)
  assert.equal(h.rejectedReads(), 1)
  assert.throws(() => h.api.getPreviewUpdatePolicy(log), /unavailable/)
  h.response({ ...artifact('0.3.0', 'release'), download_url: 'https://cdn.example/package' })
  await h.api.getDownloadInfo('release-0.3.0', log)
  assert.equal(h.requests[1].search, '')
  assert.equal(h.reads(), 0)
})

test('preview defaults to current line and rejects a server cross-line response', async () => {
  const h = harness()
  h.response({ has_update: true, latest: artifact() })
  const result = await h.api.checkForUpdate(log)
  assert.equal(h.requests[0].searchParams.get('preview_scope'), 'current-line')
  assert.equal(result.latest!.version, '0.2.1')
  assert.equal(h.writes.length, 0)
  h.response({ has_update: true, latest: artifact('0.3.0') })
  await assert.rejects(h.api.checkForUpdate(log), /outside/)
  h.api.writePreviewUpdatePolicy({ scope: 'current-version' }, log)
  h.response({ has_update: true, latest: artifact() })
  await assert.rejects(h.api.checkForUpdate(log), /outside/)
})

test('manual preview discovery and selection bind the exact published artifact', async () => {
  const h = harness()
  const target = artifact('0.3.0')
  h.response({ lines: [{ line: '0.3', latest: target }] })
  await h.api.listPreviewUpdateLines(log)
  const selected = h.api.previewTarget(target.id, log)
  h.api.writePreviewUpdatePolicy({ scope: 'current-version', target: selected }, log)
  h.response({ has_update: true, latest: target })
  assert.equal((await h.api.checkForUpdate(log)).latest!.id, target.id)
  assert.equal(h.requests.at(-1)!.searchParams.get('target_id'), target.id)
  assert.equal(h.requests.at(-1)!.searchParams.get('target_line'), '0.3')
  h.response({ ...target, download_url: 'https://cdn.example/fixed' })
  await h.api.validatePreviewCandidate(selected, log)
  assert.equal(h.api.previewCandidateValidated(selected, log), true)
  h.response({ ...target, sha512: 'b'.repeat(128), download_url: 'https://cdn.example/fixed' })
  await assert.rejects(h.api.validatePreviewCandidate(selected, log), /outside|changed/)
  h.api.writePreviewUpdatePolicy({ scope: 'current-version' }, log)
  assert.equal(h.api.previewCandidateValidated(selected, log), false)
  assert.throws(() => h.api.previewTarget(target.id, log), /no longer listed/)
})

test('a delayed check cannot publish after scope changes', async () => {
  const h = harness()
  let finish!: (value: unknown) => void
  h.responder(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const waiting = h.api.checkForUpdate(log)
  h.api.writePreviewUpdatePolicy({ scope: 'current-version' }, log)
  finish({ has_update: true, latest: artifact() })
  const old = await waiting
  assert.equal(h.api.isCurrentPreviewResult(old), false)
})

test('source identity changes durably consume consent and corrupt policy can be explicitly overwritten', () => {
  const h = harness('preview', {
    schema: preview.PREVIEW_STATE_SCHEMA,
    scope: 'current-version',
    source: 'previous-installation',
    target: artifact('0.3.0'),
  })
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.getPreviewUpdatePolicy(log))), {
    scope: 'current-version',
  })
  assert.equal(h.writes.length, 1)
  assert.equal((h.writes[0] as { target?: unknown }).target, undefined)
  const broken = harness('preview', { schema: 99 })
  assert.throws(() => broken.api.getPreviewUpdatePolicy(log), /schema/)
  broken.api.writePreviewUpdatePolicy({ scope: 'current-line' }, log)
  assert.equal(broken.api.getPreviewUpdatePolicy(log).scope, 'current-line')
})
