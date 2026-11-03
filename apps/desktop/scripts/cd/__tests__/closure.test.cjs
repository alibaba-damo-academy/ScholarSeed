const sourceDirectory = require('node:path').dirname(__dirname)
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { finished } = require('node:stream/promises')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')
const { verifyClosure, verifyAsarClosure } = require('../closure.cjs')
const closureOwner = require('../closure.cjs')
const { BUNDLED_LIBRARIES } = require('../../../native/libraries.cjs')
const { createProductAppRoot } = require('../../../e2e/fixtures/application.cjs')
const { noLinks } = require('../../shared/build-state.cjs')

const DESKTOP_MANIFEST_PATH = path.resolve(sourceDirectory, '../../package.json')

test('E2E application cache has physical ancestors without copying build dependencies', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-application-')))
  try {
    const desktop = path.join(root, 'source', 'apps', 'desktop')
    fs.mkdirSync(path.join(root, 'source', 'scripts'), { recursive: true })
    for (const entry of ['out', 'resources', 'runtime', 'node_modules']) {
      fs.mkdirSync(path.join(desktop, entry), { recursive: true })
    }
    fs.writeFileSync(path.join(desktop, 'node_modules', 'build-only'), 'must not be copied')
    fs.writeFileSync(path.join(desktop, 'package.json'), '{}')
    fs.writeFileSync(path.join(desktop, 'resources', 'product.json'), JSON.stringify({ features: { browser: false, other: true } }))
    const application = createProductAppRoot(path.join(root, 'artifacts'), desktop, true)
    const cache = path.join(application, 'node_modules', '.cache', 'scholarseed', 'codex')
    fs.mkdirSync(cache, { recursive: true })
    assert.doesNotThrow(() => noLinks(cache))
    assert.equal(fs.existsSync(path.join(application, 'node_modules', 'build-only')), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(application, 'resources', 'product.json'))).features,
      { browser: true, other: true })
    assert.equal(JSON.parse(fs.readFileSync(path.join(desktop, 'resources', 'product.json'))).features.browser, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Desktop manifest keeps npm dependencies in the build-only closure', () => {
  const manifest = JSON.parse(fs.readFileSync(DESKTOP_MANIFEST_PATH, 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies || {}), [])
})

function entries(main) {
  return new Map([
    ['out/main/index.js', main],
    ['out/main/data-inspection.js', 'module.exports = {}'],
    ['out/preload/index.js', 'require("electron")'],
  ])
}

function nativeEntries() {
  const files = entries(BUNDLED_LIBRARIES.map(name =>
    `require(${JSON.stringify(`./${path.posix.basename(name)}`)})`).join('; '))
  const native = { libraries: BUNDLED_LIBRARIES.map(name => {
    const bytes = Buffer.from(`native fixture ${name}, not executable`)
    files.set(name, bytes)
    return { path: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  }) }
  return { files, native }
}

test('Desktop inspection is mandatory and its transitive closure cannot start the application', () => {
  const files = entries('require("electron")')
  files.delete('out/main/data-inspection.js')
  assert.throws(() => verifyClosure(files), /missing compiled Desktop inspection/)
  files.set('out/main/data-inspection.js', 'require("./record-reader.js")')
  files.set('out/main/record-reader.js', 'require("node:crypto"); module.exports = {}')
  assert.doesNotThrow(() => verifyClosure(files))
  for (const capability of [
    'electron',
    'child_process',
    'node:child_process',
    'worker_threads',
    'node:worker_threads',
  ]) {
    files.set('out/main/record-reader.js', `require(${JSON.stringify(capability)})`)
    assert.throws(
      () => verifyClosure(files),
      /Desktop inspection has application or process capability/
    )
  }
  for (const dependency of ['./index.js', '../preload/index.js']) {
    files.set('out/main/record-reader.js', `require(${JSON.stringify(dependency)})`)
    assert.throws(() => verifyClosure(files), /Desktop inspection depends on application startup/)
  }
})

test('protected release closure requires a single compiled generation binding', () => {
  assert.equal(typeof closureOwner.verifyProtectedClosure, 'function')
  assert.throws(
    () => closureOwner.verifyProtectedClosure(entries('require("electron")')),
    /protected/
  )
})

function protectedEntries(files) {
  const generation = 'a'.repeat(64)
  const prefix = `out/protected/${generation}/`
  const records = [
    ['renderer/vault.html', 'local html'],
    ['preload/vault.js', 'require("electron")'],
  ].map(([name, value]) => {
    const bytes = Buffer.from(value)
    files.set(prefix + name, bytes)
    return {
      path: name,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }
  })
  const manifest = Buffer.from(
    JSON.stringify({ version: 1, generation, tools: {}, sources: [], modules: [], files: records })
  )
  const digest = crypto.createHash('sha256').update(manifest).digest('hex')
  files.set(prefix + 'manifest.json', manifest)
  files.set(
    'out/main/index.js',
    `${files.get('out/main/index.js')}; const binding = "scholarseed-protected-v1:${generation}:${digest}";`
  )
  return files
}
test('protected release closure rejects old generation, changed asset and missing preload', () => {
  const files = protectedEntries(entries('require("electron")'))
  const verified = closureOwner.verifyProtectedClosure(files)
  assert.equal(verified.files.length, 3)
  const old = new Map(files)
  old.set('out/protected/old/preload/vault.js', Buffer.from('old'))
  assert.throws(() => closureOwner.verifyProtectedClosure(old), /stale/)
  const changed = new Map(files)
  changed.set(verified.prefix + 'renderer/vault.html', Buffer.from('tampered'))
  assert.throws(() => closureOwner.verifyProtectedClosure(changed), /mismatched/)
  const missing = new Map(files)
  missing.delete(verified.prefix + 'preload/vault.js')
  assert.throws(() => closureOwner.verifyProtectedClosure(missing), /missing/)
})

test('compiled entry closure accepts host modules and real local chunks, not string lookalikes', context => {
  const files = entries(
    'require("node:fs"); require("./chunk.js"); const script = "ObjC.import(123)";'
  )
  files.set('out/main/chunk.js', 'module.exports = require("path")')
  files.set('out/main/unused.json', '{}')
  const evidence = verifyClosure(files)
  assert.deepEqual(evidence.external_modules, [])
  assert.deepEqual(evidence.host_modules, ['electron', 'node:fs', 'path'])
  assert.equal(evidence.entries.length, 4)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-entry-layout-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [name, content] of files) {
    const filename = path.join(root, name)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, content)
  }
  const result = spawnSync(process.execPath, [path.join(root, 'out/main/index.js')], {
    cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const jsonFiles = entries('require("./config.json")')
  jsonFiles.set('out/main/config.json', '{}')
  assert.equal(verifyClosure(jsonFiles).files.length, 4)
  const nativeFiles = entries('require("./addon.node")')
  nativeFiles.set('out/main/addon.node', 'fixture')
  assert.throws(() => verifyClosure(nativeFiles), /native library/)
})

test('only frozen native libraries are allowed and neither is reachable from preload or inspection', () => {
  const { files, native } = nativeEntries()
  assert.equal(verifyClosure(files, native).files.length, 3 + BUNDLED_LIBRARIES.length)
  assert.throws(() => verifyClosure(files), /frozen build digest/)
  for (const item of native.libraries) {
    const changed = { libraries: native.libraries.map(library => library === item ? { ...library, sha256: '0'.repeat(64) } : library) }
    assert.throws(() => verifyClosure(files, changed), /differs/)
    assert.throws(() => verifyClosure(files, { libraries: [item] }), /inventory/)
    const missing = new Map(files)
    missing.delete(item.path)
    assert.throws(() => verifyClosure(missing, native), /inventory/)
    const leaf = path.posix.basename(item.path)
    files.set('out/preload/index.js', `require("../main/${leaf}")`)
    assert.throws(() => verifyClosure(files, native), /preload cannot/)
    files.set('out/preload/index.js', 'require("electron")')
    files.set('out/main/data-inspection.js', `require("./${leaf}")`)
    assert.throws(() => verifyClosure(files, native), /Desktop inspection depends on application startup/)
    files.set('out/main/data-inspection.js', 'module.exports = {}')
    const unreferenced = new Map(files)
    unreferenced.set('out/main/index.js', `require("./${leaf}")`)
    assert.throws(() => verifyClosure(unreferenced, native), /unreferenced/)
  }
  assert.throws(() => verifyClosure(files, { libraries: [native.libraries[0], native.libraries[0]] }), /inventory/)
  files.set('out/preload/index.js', 'require("../main/index.js")')
  assert.throws(() => verifyClosure(files, native), /preload cannot/)
  files.set('out/preload/index.js', 'require("electron")')
  files.set('out/main/extra.node', Buffer.from('extra native fixture'))
  assert.throws(() => verifyClosure(files, native), /inventory/)
  files.delete('out/main/extra.node')
  files.set('out/main/index.js', 'require("electron")')
  assert.throws(() => verifyClosure(files, native), /unreferenced/)
})

test('native ASAR inventory rejects packed, altered, linked and additional loose libraries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-native-'))
  try {
    const source = path.join(root, 'source')
    const { files, native } = nativeEntries()
    protectedEntries(files)
    files.set('package.json', '{"main":"out/main/index.js"}')
    for (const [name, content] of files) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true })
      fs.writeFileSync(path.join(source, name), content)
    }
    const archive = path.join(root, 'app.asar')
    await finished(await asar.createPackage(source, archive))
    assert.throws(() => verifyAsarClosure(root, native), /unpacked/)
    for (const item of native.libraries) {
      await finished(await asar.createPackageWithOptions(source, archive, { unpack: path.posix.basename(item.path) }))
      asar.uncache(archive)
      assert.throws(() => verifyAsarClosure(root, native), /unpacked/)
      fs.rmSync(archive + '.unpacked', { recursive: true })
    }
    await finished(await asar.createPackageWithOptions(source, archive, { unpack: '*.node' }))
    asar.uncache(archive)
    assert.equal(verifyAsarClosure(root, native).files.length, 4 + BUNDLED_LIBRARIES.length)
    assert.throws(() => verifyAsarClosure(root), /unpacked/)
    for (const item of native.libraries) {
      const loose = path.join(archive + '.unpacked', item.path)
      const bytes = files.get(item.path)
      fs.writeFileSync(loose, Buffer.alloc(bytes.length, 1))
      assert.throws(() => verifyAsarClosure(root, native), /differs/)
      fs.writeFileSync(loose, bytes)
      const alias = path.join(root, 'alias')
      fs.linkSync(loose, alias)
      assert.throws(() => verifyAsarClosure(root, native), /identity/)
      fs.unlinkSync(alias)
    }
    fs.writeFileSync(path.join(archive + '.unpacked', 'extra.node'), 'unexpected')
    assert.throws(() => verifyAsarClosure(root, native), /unpacked/)
    fs.unlinkSync(path.join(archive + '.unpacked', 'extra.node'))
    await t.test('ASAR links are rejected before metadata resolution', async (child) => {
      try {
        fs.symlinkSync('index.js', path.join(source, 'out/main/alias.js'), 'file')
      } catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM')
          return child.skip('host denies symbolic-link creation')
        throw error
      }
      await finished(await asar.createPackageWithOptions(source, archive, { unpack: '*.node' }))
      asar.uncache(archive)
      assert.throws(() => verifyAsarClosure(root, native), /asar link/)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compiled update cleanup resolves the Electron physical filesystem host module', () => {
  const evidence = verifyClosure(entries('require("original-fs").promises.rm("candidate", { recursive: true, force: true })'))
  assert.ok(evidence.host_modules.includes('original-fs'))
})

test('compiled entry closure fails on external, non-literal and missing dependencies', () => {
  for (const code of ['require("react")', 'import "react"', 'export * from "react"']) {
    assert.throws(() => verifyClosure(entries(code)), /external npm/)
  }
  for (const code of ['require(variable)', 'import(variable)', 'module.require(variable)']) {
    assert.throws(() => verifyClosure(entries(code)), /non-literal/)
  }
  for (const code of ['require("./missing")', 'import "../../escape.js"']) {
    assert.throws(() => verifyClosure(entries(code)), /missing or escaped/)
  }
  assert.throws(() => verifyClosure(new Map()), /missing compiled/)
  for (const code of [
    'const load=require; load("left-pad")',
    'module["require"]("left-pad")',
    '(require)("left-pad")',
    'const {createRequire}=require("node:module"); createRequire(__filename)("left-pad")',
  ]) {
    assert.throws(() => verifyClosure(entries(code)), /aliased|indirect|dynamic/)
  }
})

test('compiled entry closure only flags unshadowed CommonJS module access', () => {
  const local = `function f(module) { return module.type }
    const add = (module) => module.name
    function g() { var module = {}; return module.custom }
    { let module = {}; module.exports = 1 }
    var outer = {}
    function h() { var module = function () {}; return module.custom }`
  assert.doesNotThrow(() => verifyClosure(entries(local)))
  assert.doesNotThrow(() => verifyClosure(entries('module.exports = 1; module.require("path")')))
  assert.doesNotThrow(() =>
    verifyClosure(entries('if (require.main === module) { main(process.argv.slice(2)) }'))
  )
  assert.doesNotThrow(() =>
    verifyClosure(entries('var exports = module.exports === module.exports && module === module'))
  )
  assert.throws(() => verifyClosure(entries('module.filename')), /indirect/)
  assert.throws(() => verifyClosure(entries('function g() { return module.id }')), /indirect/)
  assert.throws(() => verifyClosure(entries('try { } catch (err) { module.foo(err) }')), /indirect/)
  assert.throws(() => verifyClosure(entries('module["exports"]')), /indirect/)
  assert.throws(() => verifyClosure(entries('const load = require; load("left-pad")')), /aliased/)
})

test('exact asar is checked for duplicate renderer, npm and unpacked assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-closure-'))
  try {
    for (const [index, extra] of [
      '',
      'node_modules/pkg/index.js',
      'out/renderer/index.html',
    ].entries()) {
      const source = path.join(root, `source-${index}`)
      const output = path.join(root, `output-${index}`)
      fs.mkdirSync(output)
      const files = protectedEntries(entries('require("electron")'))
      files.set('package.json', '{"main":"out/main/index.js"}')
      if (extra) files.set(extra, 'fixture')
      for (const [name, content] of files) {
        fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true })
        fs.writeFileSync(path.join(source, name), content)
      }
      await finished(await asar.createPackage(source, path.join(output, 'app.asar')))
      if (extra) assert.throws(() => verifyAsarClosure(output), /duplicate/)
      else {
        assert.equal(verifyAsarClosure(output).entries.length, 4)
        fs.mkdirSync(path.join(output, 'app.asar.unpacked'))
        fs.writeFileSync(path.join(output, 'app.asar.unpacked/extra.node'), 'fixture')
        assert.throws(() => verifyAsarClosure(output), /unpacked/)
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('protected preload and inspection cannot acquire each other or native capabilities', () => {
  const { files, native } = nativeEntries()
  protectedEntries(files)
  const preload = closureOwner.verifyProtectedClosure(files).prefix + 'preload/vault.js'
  files.set(preload, 'require("../../../main/bridge.js")')
  for (const item of native.libraries) {
    files.set('out/main/bridge.js', `require("./${path.posix.basename(item.path)}")`)
    assert.throws(() => verifyClosure(files, native, preload), /preload cannot depend on the native/)
  }
  files.set(preload, 'module.exports = {}')
  files.set(
    'out/main/data-inspection.js',
    `require("../protected/${'a'.repeat(64)}/preload/vault.js")`
  )
  assert.throws(() => verifyClosure(files, native, preload), /missing or escaped compiled module/)
})
