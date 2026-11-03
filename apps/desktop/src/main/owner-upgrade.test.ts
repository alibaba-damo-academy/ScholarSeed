import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import type { checkForUpdate } from './updater.ts'
import { isNewerRelease } from './version.ts'
import { buildUpdateCheckUrl, parseUpdateCheckResult } from './release.ts'
import * as preview from './preview.ts'
import { isPreviewUpdateChannel } from '../updates.ts'

// Run the production check orchestration against the service's version ordering.
const source = ts.createSourceFile(
  'updater.ts',
  readFileSync(new URL('./updater.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const names = new Set([
  'checkForUpdate',
  'monotonicUpdateResult',
  'previewUpdatesEnabled',
  'previewSource',
  'getPreviewUpdatePolicy',
  'writePreviewUpdatePolicy',
  'currentPreviewContext',
  'readRejectedUpdate',
  'rejectedUpdatePath',
  'candidateStateDirectory',
])
const constants = new Set([
  'PREVIEW_CANDIDATE_DIRNAME',
  'REJECTED_STATE_FILE',
  'REJECTED_STATE_LIMIT',
])
const declarations = source.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? '')) ||
    (ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        constants.has(declaration.name.getText(source))
      ))
)
assert.equal(declarations.length, names.size + constants.size)
const code = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const config = {
  baseUrl: 'https://example.test',
  channel: 'preview',
  buildNumber: '202610161200',
  productId: 'scholarseed',
  bundleId: 'com.scholarseed.desktop',
  expectedWindowsPublisher: 'publisher',
  expectedTeamId: '',
  releaseLane: 'distribution' as const,
}
const current = {
  id: 'current',
  version: '0.2.0',
  build_number: config.buildNumber,
  product_id: config.productId,
  bundle_id: config.bundleId,
  channel: config.channel,
  arch_type: 'windows-amd64',
  file_size: 100,
  sha512: 'a'.repeat(128),
}
function harness(latest = current, platform = 'win32', forceOffer = false) {
  const targetArch = platform === 'darwin' ? 'darwin-arm64' : 'windows-amd64'
  const policy = { ...config, expectedTeamId: platform === 'darwin' ? 'KYG3VP6NVH' : '' }
  const candidate = {
    ...latest,
    arch_type: targetArch,
    ...(platform === 'darwin' ? { team_id: policy.expectedTeamId } : {}),
  }
  const urls: URL[] = []
  const records: string[] = []
  const context = {
    ...preview,
    isPreviewUpdateChannel,
    structuredClone,
    URL,
    join,
    previewRevision: 0,
    previewPolicy: null,
    updateStateDirectory: () => '/owned/updates',
    readRecord: (path: string) => {
      records.push(path)
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    writeJson: () => {
      throw new Error('unexpected policy write')
    },
    exports: {},
    process: { platform },
    app: { getVersion: () => current.version },
    archType: () => targetArch,
    resolveDesktopConfig: () => policy,
    isNewerRelease,
    buildUpdateCheckUrl,
    parseUpdateCheckResult,
    previewUpdatesEnabled: () => false,
    getJson: async (raw: string) => {
      const url = new URL(raw)
      urls.push(url)
      const newer = isNewerRelease(
        {
          version: url.searchParams.get('version')!,
          buildNumber: url.searchParams.get('build_number')!,
        },
        { version: latest.version, buildNumber: latest.build_number }
      )
      return { has_update: forceOffer || newer, latest: forceOffer || newer ? candidate : null }
    },
  }
  runInNewContext(code, context)
  return {
    urls,
    records,
    check: () =>
      (context.exports as { checkForUpdate: typeof checkForUpdate }).checkForUpdate(() => {}),
  }
}

test('Windows performs one Velopack check and never offers equal or older builds', async () => {
  for (const build of [config.buildNumber, '202610161100']) {
    const h = harness({ ...current, build_number: build }, 'win32', true)
    const result = await h.check()
    assert.equal(result.has_update, false)
    assert.equal(result.latest, null)
    assert.equal(h.urls.length, 1)
    assert.deepEqual(h.records, [
      join('/owned/updates', 'preview.json'),
      join('/owned/updates', 'preview', 'rejected.json'),
    ])
    const query = h.urls[0].searchParams
    assert.equal(query.get('update_engine'), 'velopack')
    assert.equal(query.get('build_number'), config.buildNumber)
    assert.equal(query.get('product'), config.productId)
    assert.equal(query.get('updater_capability'), null)
    assert.equal(query.get('carrier_maintenance'), null)
  }
})

test('Windows offers a newer build of the same product version in one check', async () => {
  const h = harness({ ...current, id: 'new-build', build_number: '202610161300' })
  const result = await h.check()
  assert.equal(result.has_update, true)
  assert.equal(result.latest!.id, 'new-build')
  assert.equal(result.latest!.version, current.version)
  assert.equal(h.urls.length, 1)
})

test('product version ordering takes precedence over build stamp without maintenance fallback', async () => {
  const newer = harness({
    ...current,
    id: 'new-version',
    version: '0.2.1',
    build_number: '202610151000',
  })
  assert.equal((await newer.check()).latest!.id, 'new-version')
  assert.equal(newer.urls.length, 1)
  const older = harness(
    { ...current, version: '0.1.9', build_number: '202610171200' },
    'win32',
    true
  )
  assert.equal((await older.check()).has_update, false)
  assert.equal(older.urls.length, 1)
})

test('macOS retains one standard check without Windows engine or maintenance parameters', async () => {
  const h = harness({ ...current, id: 'mac-new', build_number: '202610161300' }, 'darwin')
  assert.equal((await h.check()).latest!.id, 'mac-new')
  assert.equal(h.urls.length, 1)
  const query = h.urls[0].searchParams
  assert.equal(query.get('arch_type'), 'darwin-arm64')
  assert.equal(query.get('update_engine'), null)
  assert.equal(query.get('updater_capability'), null)
  assert.equal(query.get('carrier_maintenance'), null)
  const equal = harness(current, 'darwin')
  assert.equal((await equal.check()).has_update, false)
  assert.equal(equal.urls.length, 1)
})
