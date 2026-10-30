const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runtimeTreeEvidence, bindComponentVersions, runtimeComponent, freezeRuntimeProduct, runtimeArtifacts, publishRuntime } = require('../windows-runtime.cjs')
const { runtimeReuseEvidence, waitForRetirement, verifyComponentArchives, verifyComponentInventory } = require('../verify.cjs')
const { bundledWindowsRuntime, RUNTIME_COMPONENT_KINDS, RUNTIME_ENTRIES, validateRuntimeManifest, sha256FileSync, derivePythonContentId } = require('../../../runtime/components.cjs')

test('copied runtime files are independent of hardlinked uv cache material', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-copy-')))
  try {
    const cache = path.join(root, 'cache.py')
    const linked = path.join(root, 'linked')
    const copied = path.join(root, 'copied')
    fs.mkdirSync(linked)
    fs.writeFileSync(cache, 'original')
    fs.linkSync(cache, path.join(linked, 'module.py'))
    assert.equal(fs.statSync(cache).nlink, 2)
    assert.throws(() => runtimeTreeEvidence(linked), /invalid build state object/)
    fs.cpSync(linked, copied, { recursive: true })
    assert.equal(fs.statSync(path.join(copied, 'module.py')).nlink, 1)
    assert.equal(runtimeTreeEvidence(copied).files, 1)
    fs.writeFileSync(path.join(copied, 'module.py'), 'normalized')
    assert.equal(fs.readFileSync(cache, 'utf8'), 'original')
    assert.equal(fs.readFileSync(path.join(linked, 'module.py'), 'utf8'), 'original')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function runtimeManifest() {
  return {schema: 1, domain: 'scholarseed.runtime-components', product_id: 'scholarseed', bundle_id: 'com.scholarseed.desktop',
    app_id: 'scholarseed', target: 'win32-x86_64', components: RUNTIME_COMPONENT_KINDS.map(kind => ({
      kind, version: '1.0-r1', contentId: 'a'.repeat(64), archive: `${kind}.zip`, archiveSha256: 'b'.repeat(64),
      archiveBytes: 10, expandedBytes: 5, fileCount: 1, entry: RUNTIME_ENTRIES[kind],
      files: [{path: kind === 'texlive' ? `${RUNTIME_ENTRIES[kind]}/xelatex.exe` : RUNTIME_ENTRIES[kind], size: 5, sha256: 'c'.repeat(64)}]
    }))}
}
test('registered component paths follow reviewed versions outside current and reject unsafe manifests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-layout-'))
  try {
    const app = path.join(directory, 'current'), manifest = runtimeManifest()
    fs.mkdirSync(path.join(app, 'resources', 'components'), {recursive: true})
    const filename = path.join(app, 'resources', 'components', 'runtime.json')
    fs.writeFileSync(filename, JSON.stringify({schema: 1, key_id: '', signature: '', manifest: Buffer.from(JSON.stringify(manifest)).toString('base64')}))
    const runtime = bundledWindowsRuntime(app)
    for (const kind of RUNTIME_COMPONENT_KINDS) assert.equal(runtime[kind], path.join(directory, 'runtime', kind, '1.0-r1', ...(kind === 'office' ? [] : RUNTIME_ENTRIES[kind].split('/'))))
    assert.equal(validateRuntimeManifest(manifest), true)
    for (const mutate of [m => {m.components[0].version = '../escape'}, m => {m.components[0].files[0].path = 'python/../bad'},
      m => {m.components[0].files.push({...m.components[0].files[0]}); m.components[0].fileCount++},
      m => {m.components[0].expandedBytes++}, m => {m.app_id = 'other'}]) {
      const bad = structuredClone(manifest); mutate(bad); assert.equal(validateRuntimeManifest(bad), false)
    }
    assert.throws(() => bundledWindowsRuntime('relative'), /absolute/)
  } finally {fs.rmSync(directory, {recursive: true, force: true})}
})
test('generic runtime manifests accept a signed additional component without changing extraction schema', () => {
  const manifest = runtimeManifest()
  manifest.components.push({...structuredClone(manifest.components[0]), kind: 'future-tool', archive: 'future-tool.zip'})
  assert.equal(validateRuntimeManifest(manifest), true)
  manifest.components[5].kind = '../unsafe'
  assert.equal(validateRuntimeManifest(manifest), false)
  manifest.components = Array.from({length: 33}, (_, i) => ({...manifest.components[0], kind: `tool-${i}`, archive: `tool-${i}.zip`}))
  assert.equal(validateRuntimeManifest(manifest), false)
})

test('component root receipt name cannot be supplied by an archive in any casing', () => {
  for (const reserved of ['.scholarseed-component.json', '.SCHOLARSEED-COMPONENT.JSON', '.ScholarSeed-Component.json', '.SCHOLARSEED-COMPONENT.JSON/child']) {
    const manifest = runtimeManifest()
    manifest.components[0].files.unshift({path: reserved, size: 0, sha256: 'd'.repeat(64)})
    manifest.components[0].fileCount++
    assert.equal(validateRuntimeManifest(manifest), false, reserved)
  }
  const manifest = runtimeManifest()
  manifest.components[0].files.push({path: 'python/sub/.scholarseed-component.json', size: 0, sha256: 'd'.repeat(64)})
  manifest.components[0].fileCount++
  assert.equal(validateRuntimeManifest(manifest), true)
})

test('component identities cannot collide in the readable download archive filename', () => {
  const manifest = runtimeManifest()
  const component = structuredClone(manifest.components[0])
  manifest.components = [
    {...component, kind: 'a-b', archive: 'a-b.zip', version: '1-r1'},
    {...component, kind: 'a', archive: 'a.zip', version: 'b-1-r1'},
  ]
  assert.equal(validateRuntimeManifest(manifest), false)
  manifest.components[1].version = 'b-2-r1'
  assert.equal(validateRuntimeManifest(manifest), true)
})

test('component kind and version must be valid Windows directory names', () => {
  for (const kind of ['aux', 'con', 'nul', 'com1']) {
    const manifest = runtimeManifest()
    manifest.components[0].kind = kind
    manifest.components[0].archive = `${kind}.zip`
    assert.equal(validateRuntimeManifest(manifest), false, kind)
  }
  const manifest = runtimeManifest()
  manifest.components[0].version = 'con.foo-r1'
  assert.equal(validateRuntimeManifest(manifest), false)
})

test('delivery identity follows measured tree rather than a changed CI recipe identity', () => {
  const files = [{path: 'python/python.exe', size: 5, sha256: 'c'.repeat(64)}]
  const measured = {treeSha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), archiveBytes: 10, expandedBytes: 5, files}
  const inputs = {target: 'win32-x86_64', pythonArchiveSha256: 'f'.repeat(64), requirementsSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64), bytecodeSha256: 'c'.repeat(64), binaryPackages: []}
  const firstBuild = {inputContentId: derivePythonContentId({...inputs, recipe: {files: [['bundle.cjs', '1'.repeat(64)]]}}), inventory: measured}
  const changedRecipe = {inputContentId: derivePythonContentId({...inputs, recipe: {files: [['bundle.cjs', '2'.repeat(64)]]}}), inventory: structuredClone(measured)}
  assert.notEqual(firstBuild.inputContentId, changedRecipe.inputContentId)
  assert.deepEqual(runtimeComponent('python', firstBuild.inventory), runtimeComponent('python', changedRecipe.inventory))
  assert.equal(runtimeComponent('python', measured).contentId, measured.treeSha256)
  assert.equal(runtimeComponent('python', {...measured, archiveSha256: 'd'.repeat(64)}).contentId, measured.treeSha256)
  assert.notEqual(runtimeComponent('python', {...measured, treeSha256: 'e'.repeat(64)}).contentId, measured.treeSha256)
  assert.throws(() => runtimeComponent('python', {...measured, treeSha256: undefined}), /measured tree inventory/)
})

test('version bindings reject unreviewed inputs and archive bytes', () => {
  const components = runtimeManifest().components
  const bindings = {schema: 1, target: 'win32-x86_64', components: Object.fromEntries(components.map(c => [c.kind, {version: c.version, contentId: c.contentId, archiveSha256: c.archiveSha256}]))}
  assert.deepEqual(bindComponentVersions(components, bindings), components)
  const changed = structuredClone(components); changed[0].contentId = 'd'.repeat(64)
  assert.throws(() => bindComponentVersions(changed, bindings), /binding differs: python/)
  const changedArchive = structuredClone(components); changedArchive[0].archiveSha256 = 'd'.repeat(64)
  assert.throws(() => bindComponentVersions(changedArchive, bindings), /binding differs/)
  bindings.components.python.contentId = null
  assert.throws(() => bindComponentVersions(components, bindings), /binding differs/)
})

test('runtime tree evidence survives relocation and detects added, removed or changed files', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-tree-')))
  try {
    const source=path.join(root,'source'), target=path.join(root,'target')
    fs.mkdirSync(path.join(source,'Lib'), {recursive:true})
    fs.writeFileSync(path.join(source,'python.exe'),'interpreter')
    fs.writeFileSync(path.join(source,'Lib','module.py'),'original')
    const expected=runtimeTreeEvidence(source)
    fs.cpSync(source,target,{recursive:true})
    assert.deepEqual(runtimeTreeEvidence(target),expected)
    fs.writeFileSync(path.join(target,'Lib','module.py'),'tampered')
    assert.notDeepEqual(runtimeTreeEvidence(target),expected)
    fs.copyFileSync(path.join(source,'Lib','module.py'),path.join(target,'Lib','module.py'))
    fs.writeFileSync(path.join(target,'injected.dll'),'injection')
    assert.notDeepEqual(runtimeTreeEvidence(target),expected)
    fs.unlinkSync(path.join(target,'injected.dll'))
    fs.unlinkSync(path.join(target,'python.exe'))
    assert.notDeepEqual(runtimeTreeEvidence(target),expected)
  } finally { fs.rmSync(root,{recursive:true,force:true}) }
})

test('prepared runtime compares complete paths and rejects added, missing or changed files', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-inventory-')))
  try {
    const nested = path.join(root, 'foo', 'entry'), sibling = path.join(root, 'foo-bar.txt')
    fs.mkdirSync(path.dirname(nested))
    fs.writeFileSync(nested, 'nested')
    fs.writeFileSync(sibling, 'sibling')
    const receipt = path.join(root, '.scholarseed-component.json')
    fs.writeFileSync(receipt, '{}')
    const component = {kind: 'python', files: [
      {path: 'foo-bar.txt', size: 7, sha256: sha256FileSync(sibling)},
      {path: 'foo/entry', size: 6, sha256: sha256FileSync(nested)},
    ]}
    assert.doesNotThrow(() => verifyComponentInventory(root, component))
    const rejects = () => assert.throws(() => verifyComponentInventory(root, component), /prepared runtime inventory differs: python/)
    fs.writeFileSync(path.join(root, 'extra.dll'), 'extra')
    rejects()
    fs.unlinkSync(path.join(root, 'extra.dll'))
    fs.unlinkSync(sibling)
    rejects()
    fs.writeFileSync(sibling, 'sibling')
    fs.writeFileSync(nested, 'longer content')
    rejects()
    fs.writeFileSync(nested, 'mutant') // Same size; the digest must still reject it.
    rejects()
    fs.writeFileSync(nested, 'nested')
    const nestedReceipt = path.join(root, 'foo', '.scholarseed-component.json')
    fs.writeFileSync(nestedReceipt, '{}')
    rejects() // Only the component-root completion receipt is excluded.
    fs.unlinkSync(nestedReceipt)
    assert.doesNotThrow(() => verifyComponentInventory(root, component))
    fs.unlinkSync(receipt)
    assert.throws(() => verifyComponentInventory(root, component), /ENOENT/)
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})

test('runtime reuse evidence detects replacement and official uninstall must retire the entire root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-retirement-'))
  try {
    const app = path.join(root, 'current'), manifest = runtimeManifest()
    fs.mkdirSync(path.join(app, 'resources', 'components'), {recursive: true})
    fs.writeFileSync(path.join(app, 'resources', 'components', 'runtime.json'), JSON.stringify({schema: 1, key_id: '', signature: '', manifest: Buffer.from(JSON.stringify(manifest)).toString('base64')}))
    for (const component of manifest.components) {
      const directory = path.join(root, 'runtime', component.kind, component.version)
      const filename = path.join(directory, component.files[0].path)
      fs.mkdirSync(path.dirname(filename), {recursive: true})
      fs.writeFileSync(filename, 'bytes')
      fs.writeFileSync(path.join(directory, '.scholarseed-component.json'), '{}')
    }
    const before = runtimeReuseEvidence(app)
    assert.deepEqual(runtimeReuseEvidence(app), before)
    const selected = path.join(root, 'runtime', 'python', '1.0-r1', 'python/python.exe')
    fs.renameSync(selected, selected + '.previous')
    fs.writeFileSync(selected, 'bytes')
    assert.notDeepEqual(runtimeReuseEvidence(app), before)
    await assert.rejects(waitForRetirement(root, 0), /left installation\/runtime files/)
    const removing = setTimeout(() => fs.rmSync(root, {recursive: true}), 10)
    try { await waitForRetirement(root, 1000) } finally { clearTimeout(removing) }
    assert.equal(fs.existsSync(root), false)
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})

test('retirement allows the SDK uninstall hook and delayed self-deletion to finish', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-retirement-budget-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  fs.writeFileSync(path.join(root, 'Update.exe'), 'pending SDK uninstall')
  t.mock.timers.enable({apis: ['Date', 'setTimeout']})
  // The official SDK permits a 60s hook, then schedules root self-deletion.
  setTimeout(() => fs.rmSync(root, {recursive: true}), 65_000)
  let failure
  const waiting = waitForRetirement(root).catch(error => { failure = error })
  for (let elapsed = 0; elapsed < 66_000; elapsed += 200) {
    t.mock.timers.tick(200)
    await Promise.resolve()
  }
  await waiting
  assert.equal(failure, undefined)
  assert.equal(fs.existsSync(root), false)
})

test('retirement still fails for persistent residue and never mistakes access denial for absence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-retirement-failure-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const residue = path.join(root, 'runtime-residue.txt')
  fs.writeFileSync(residue, 'remaining runtime bytes')
  t.mock.timers.enable({apis: ['Date', 'setTimeout']})
  const waiting = assert.rejects(waitForRetirement(root), {code: 'UNINSTALL_RETIREMENT_TIMEOUT'})
  for (let elapsed = 0; elapsed < 121_000; elapsed += 200) {
    t.mock.timers.tick(200)
    await Promise.resolve()
  }
  await waiting
  assert.equal(fs.existsSync(root), true)
  assert.equal(fs.readFileSync(residue, 'utf8'), 'remaining runtime bytes')
  const stat = t.mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}) })
  await assert.rejects(waitForRetirement(root, 0), {code: 'EACCES'})
  stat.mock.restore()
})

test('static packaged component checks do not require expanded runtime or execute Python', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-static-'))
  try {
    const app = path.join(root, 'current'), resources = path.join(app, 'resources')
    const manifest = runtimeManifest()
    const put = (relative, content = 'bytes') => {
      const filename = path.join(app, relative)
      fs.mkdirSync(path.dirname(filename), {recursive: true}); fs.writeFileSync(filename, content)
      return filename
    }
    const envelope = put('resources/components/runtime.json', JSON.stringify({schema: 1, key_id: '', signature: '', manifest: Buffer.from(JSON.stringify(manifest)).toString('base64')}))
    const current = {resources, executable: put('ScholarSeed.exe'), rg: put('resources/backend/bin/rg.exe'), skillPython: put('resources/backend/bin/skill.cmd')}
    put('resources/renderer/index.html')
    const config = put('resources/defaults/config.json'), product = put('resources/product.json'), lock = put('resources/backend/skills.lock.json')
    const requirements = put('resources/backend/python-requirements.txt'), inventory = put('resources/backend/python-dependencies.json'), verifier = put('resources/backend/dependencies.py')
    const frozen = {runtime: {manifestSha256: sha256FileSync(envelope)}, components: {components: manifest.components},
      config: {sha256: sha256FileSync(config)}, product: {sha256: sha256FileSync(product)}, lockSha256: sha256FileSync(lock),
      binaries: {rg: {sha256: sha256FileSync(current.rg)}}, pythonDependencies: {requirements_sha256: sha256FileSync(requirements), inventory_sha256: sha256FileSync(inventory), verifier_sha256: sha256FileSync(verifier)}}
    const result = await verifyComponentArchives(app, frozen, current, {})
    assert.equal(result.imports, null)
    assert.equal(fs.existsSync(path.join(root, 'runtime')), false)
    fs.writeFileSync(path.join(resources, 'components', 'python.zip'), 'unexpected archive')
    await assert.rejects(verifyComponentArchives(app, frozen, current, {}), /unexpected bundled component material/)
  } finally {fs.rmSync(root, {recursive: true, force: true})}
})


test('independent runtime artifacts bind every signed entry and reject altered delivery bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-delivery-'))
  try {
    const context = deliveryContext(root)
    const result = runtimeArtifacts(context)
    assert.equal(result.manifest_path, context.runtime.manifestPath)
    assert.equal(result.components.length, RUNTIME_COMPONENT_KINDS.length + 1)
    assert.equal(result.components.at(-1).kind, 'future-tool')
    assert.deepEqual(fs.readdirSync(path.dirname(result.manifest_path)), ['runtime.json'])
    const archive = result.components[0].path
    fs.writeFileSync(archive, 'wrong')
    assert.throws(() => runtimeArtifacts(context), /runtime delivery archive differs/)
    fs.writeFileSync(archive, 'bytes')
    fs.writeFileSync(path.join(context.runtime.archivesDirectory, 'extra.zip'), 'extra')
    assert.throws(() => runtimeArtifacts(context), /unexpected runtime delivery material/)
    fs.unlinkSync(path.join(context.runtime.archivesDirectory, 'extra.zip'))
    fs.appendFileSync(context.runtime.manifestPath, ' ')
    assert.throws(() => runtimeArtifacts(context), /runtime envelope changed/)
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})

function deliveryContext(root) {
  const manifest = runtimeManifest()
  manifest.components.push({...structuredClone(manifest.components[0]), kind: 'future-tool', archive: 'future-tool.zip'})
  const archivesDirectory = path.join(root, 'runtime-components')
  const componentsDirectory = path.join(root, 'resources', 'components')
  fs.mkdirSync(archivesDirectory)
  fs.mkdirSync(componentsDirectory, {recursive: true})
  for (const component of manifest.components) {
    const archive = path.join(archivesDirectory, component.archive)
    fs.writeFileSync(archive, 'bytes')
    component.archiveBytes = 5
    component.archiveSha256 = sha256FileSync(archive)
  }
  const manifestPath = path.join(componentsDirectory, 'runtime.json')
  fs.writeFileSync(manifestPath, JSON.stringify({schema: 1, key_id: 'fixture', signature: 'fixture', manifest: Buffer.from(JSON.stringify(manifest)).toString('base64')}))
  return {platform: 'win32', signingRequired: true, payloadSigning: {key_id: 'fixture'}, type: 'preview', candidate: false,
    runtime: {manifestPath, archivesDirectory, manifestSha256: sha256FileSync(manifestPath)}, components: {components: manifest.components}}
}

test('runtime publication is explicit CI-only and completes before returning frozen artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-publish-'))
  try {
    const context = deliveryContext(root)
    const receipt = path.join(root, 'invocation.json')
    const script = path.join(root, 'record.cjs')
    fs.writeFileSync(script, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))')
    const configured = JSON.stringify([process.execPath, script, receipt])
    const environment = {CI: 'true', SCHOLARSEED_RUNTIME_PUBLISH_COMMAND: configured}
    publishRuntime({...context, payloadSigning: null}, environment)
    publishRuntime({...context, candidate: true}, environment)
    publishRuntime({...context, platform: 'darwin'}, environment)
    assert.equal(fs.existsSync(receipt), false)
    assert.throws(() => publishRuntime(context, {...environment, CI: ''}), /CI-only/)
    assert.throws(() => publishRuntime(context, {CI: 'true'}), /requires a runtime publication command/)
    assert.throws(() => publishRuntime(context, {...environment, SCHOLARSEED_RUNTIME_PUBLISH_COMMAND: '{}'}), /invalid runtime publication command/)
    publishRuntime(context, environment)
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), ['--manifest', context.runtime.manifestPath, '--directory', context.runtime.archivesDirectory])
    fs.writeFileSync(script, 'process.exit(1)')
    assert.throws(() => publishRuntime(context, environment))
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})

test('Windows product binds the exact initial runtime envelope without changing macOS bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-product-'))
  try {
    const context = deliveryContext(root)
    const productPath = path.join(root, 'product.json')
    const original = '{"product_id":"scholarseed"}\n'
    fs.writeFileSync(productPath, original)
    context.product = {path: productPath, config: JSON.parse(original), sha256: sha256FileSync(productPath)}
    freezeRuntimeProduct({...context, platform: 'darwin'})
    assert.equal(fs.readFileSync(productPath, 'utf8'), original)
    assert.equal(Object.hasOwn(context.product.config, 'runtime_manifest_sha256'), false)
    freezeRuntimeProduct(context)
    assert.equal(context.product.config.runtime_manifest_sha256, context.runtime.manifestSha256)
    assert.deepEqual(JSON.parse(fs.readFileSync(productPath, 'utf8')), context.product.config)
    assert.equal(sha256FileSync(productPath), context.product.sha256)
    fs.appendFileSync(context.runtime.manifestPath, ' ')
    assert.throws(() => freezeRuntimeProduct(context), /changed before product binding/)
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})
