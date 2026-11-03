// Deterministic validation contracts, not installed Electron acceptance.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { verifyEngineEvidence, verifyNativeExports, sameRuntimePath } = require('../verify.cjs')
const { RUNTIME_DOMAIN } = require('../../../runtime/components.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-enginecheck-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const application = path.join(root, '中文 ScholarSeed', 'current')
  const resources = path.join(application, 'resources')
  const entry = 'ScholarSeedEngine.exe'
  const component = {
    kind: 'electron',
    version: '44.3.0-r1',
    entry,
    archive: 'electron.zip',
    contentId: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    archiveBytes: 1,
    expandedBytes: 1,
    fileCount: 1,
    files: [{ path: entry, size: 1, sha256: 'c'.repeat(64) }],
  }
  const manifest = {
    schema: 1,
    domain: RUNTIME_DOMAIN,
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    app_id: 'scholarseed',
    target: 'win32-x86_64',
    components: [component],
  }
  fs.mkdirSync(path.join(resources, 'components'), { recursive: true })
  fs.writeFileSync(
    path.join(resources, 'components', 'runtime.json'),
    JSON.stringify({
      schema: 1,
      manifest: Buffer.from(JSON.stringify(manifest)).toString('base64'),
      key_id: '',
      signature: '',
    })
  )
  const frozen = {
    platform: 'win32',
    productName: 'ScholarSeed',
    version: '0.2.0',
    electron: { version: '44.3.0' },
    native: {
      libraries: ['lease.node', 'fonts.node', 'velopack.node'].map((name) => ({
        path: `out/main/${name}`,
      })),
    },
  }
  const engine = path.join(path.dirname(application), 'runtime', 'electron', component.version)
  const evidence = {
    version: '44.3.0',
    node: '24.15.0',
    modules: '145',
    napi: '10',
    packaged: true,
    appVersion: frozen.version,
    appPath: path.join(resources, 'app.asar'),
    executable: path.join(engine, entry),
    resources: path.join(engine, 'resources'),
    applicationResources: resources,
    launcher: path.join(application, 'ScholarSeed.exe'),
    nativeModules: frozen.native.libraries.map((item) => ({
      path: path.join(resources, 'app.asar', item.path),
      loaded: true,
    })),
  }
  return { application, frozen, evidence }
}

test('installed engine evidence accepts real paths and all loaded native modules', (t) => {
  const { application, frozen, evidence } = fixture(t)
  assert.equal(verifyEngineEvidence(application, frozen, evidence), evidence)
  for (const item of evidence.nativeModules)
    item.path = item.path.replace('app.asar', 'app.asar.unpacked')
  assert.equal(verifyEngineEvidence(application, frozen, evidence), evidence)
})

test('installed engine evidence rejects wrong engine, app, ABI or packaged identity', (t) => {
  const { application, frozen, evidence } = fixture(t)
  for (const change of [
    { version: '45.0.0' },
    { appVersion: '0.1.0' },
    { packaged: false },
    { node: '' },
    { modules: '' },
    { napi: '' },
  ])
    assert.throws(
      () => verifyEngineEvidence(application, frozen, { ...evidence, ...change }),
      /runtime identity/
    )
  assert.throws(() => verifyEngineEvidence(application, frozen, undefined), /runtime identity/)
})

test('installed engine evidence rejects confusing stable launcher, code or engine resources', (t) => {
  const { application, frozen, evidence } = fixture(t)
  for (const field of ['appPath', 'applicationResources', 'launcher', 'executable', 'resources']) {
    assert.throws(
      () =>
        verifyEngineEvidence(application, frozen, {
          ...evidence,
          [field]: path.join(application, 'wrong'),
        }),
      new RegExp(`path differs: ${field}`)
    )
  }
  assert.throws(
    () => verifyEngineEvidence(application, frozen, { ...evidence, executable: evidence.launcher }),
    /path differs: executable/
  )
  assert.throws(
    () =>
      verifyEngineEvidence(application, frozen, {
        ...evidence,
        resources: evidence.applicationResources,
      }),
    /path differs: resources/
  )
})

test('installed engine evidence requires the exact successfully loaded native module closure', (t) => {
  const { application, frozen, evidence } = fixture(t)
  for (const change of [
    { loaded: false },
    { path: path.join(application, 'other.node') },
  ]) {
    const nativeModules = structuredClone(evidence.nativeModules)
    Object.assign(nativeModules[0], change)
    assert.throws(
      () => verifyEngineEvidence(application, frozen, { ...evidence, nativeModules }),
      /did not load/
    )
  }
  assert.throws(
    () =>
      verifyEngineEvidence(application, frozen, {
        ...evidence,
        nativeModules: evidence.nativeModules.slice(1),
      }),
    /closure differs/
  )
  const duplicate = [
    evidence.nativeModules[0],
    evidence.nativeModules[0],
    evidence.nativeModules[2],
  ]
  assert.throws(
    () => verifyEngineEvidence(application, frozen, { ...evidence, nativeModules: duplicate }),
    /did not load/
  )
})

test('macOS verification does not adopt Windows engine paths or require new evidence', () => {
  assert.equal(
    verifyEngineEvidence('not-an-installed-windows-app', { platform: 'darwin' }, undefined),
    undefined
  )
})

test('native ABI probe requires exports from every exact frozen physical module', (t) => {
  const { application, frozen } = fixture(t)
  const modules = frozen.native.libraries.map(library => ({
    path: path.join(application, 'resources', 'app.asar.unpacked', library.path),
    exports: ['binding'],
  }))
  verifyNativeExports(application, frozen, modules)
  assert.throws(() => verifyNativeExports(application, frozen, modules.slice(1)), /closure differs/)
  for (const change of [{ exports: [] }, { exports: [42] }, { path: path.join(application, 'other.node') }]) {
    const invalid = structuredClone(modules)
    Object.assign(invalid[0], change)
    assert.throws(() => verifyNativeExports(application, frozen, invalid), /exports unavailable/)
  }
  assert.throws(() => verifyNativeExports(application, frozen, [modules[0], modules[0], modules[2]]), /exports unavailable/)
})

test('Windows runtime paths compare ordinary and namespaced drive or UNC paths', () => {
  const drive = String.raw`C:\Scholar Seed\current\resources\app.asar.unpacked\out\main\lease.node`
  const share = String.raw`\\server\share\Scholar Seed\lease.node`
  for (const filename of [drive, share]) {
    assert.equal(sameRuntimePath(path.win32.toNamespacedPath(filename), filename, path.win32), true)
    assert.equal(sameRuntimePath(filename.toUpperCase(), filename, path.win32), true)
  }
  assert.equal(sameRuntimePath(drive.replace('C:', 'D:'), drive, path.win32), false)
  assert.equal(sameRuntimePath(share.replace('server', 'other'), share, path.win32), false)
  assert.equal(sameRuntimePath(undefined, drive, path.win32), false)
})
