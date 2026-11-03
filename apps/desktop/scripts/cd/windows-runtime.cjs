// Build-only evidence and independent delivery of complete runtime trees.
const state = require('../shared/build-state.cjs')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { envelope } = require('./velopack.cjs')
const { RUNTIME_DOMAIN, RUNTIME_COMPONENT_KINDS, COMPONENT_VERSION_PATTERN,
  RUNTIME_MANIFEST_FILENAME, RUNTIME_MANIFEST_LIMIT, RUNTIME_ENTRIES, CONTENT_ID_PATTERN, validateRuntimeManifest, sha256FileSync } = require('../../runtime/components.cjs')
const VERSIONS_FILE = path.join(__dirname, '../../runtime/versions.json')
const ARCHIVES_DIRECTORY = 'runtime-components'
const PUBLISH_COMMAND_ENV = 'SCHOLARSEED_RUNTIME_PUBLISH_COMMAND'
const CI_NAMES = ['CI', 'GITLAB_CI', 'GITHUB_ACTIONS', 'AONE_CI']
function bindComponentVersions(components, bindings) {
  if (bindings?.schema !== 1 || bindings.target !== 'win32-x86_64') throw new Error('invalid runtime version bindings')
  return components.map(component => {
    const binding = bindings.components?.[component.kind]
    if (!binding || !COMPONENT_VERSION_PATTERN.test(binding.version || '') ||
        binding.contentId !== component.contentId || binding.archiveSha256 !== component.archiveSha256)
      throw new Error(`runtime version binding differs: ${component.kind}; review component-version-observed.json and bump the reviewed revision`)
    return { ...component, version: binding.version }
  })
}
// Delivery identity follows measured bytes, independently of CI recipe/cache keys.
function runtimeComponent(kind, inventory) {
  if (!CONTENT_ID_PATTERN.test(inventory?.treeSha256 || '') || !Array.isArray(inventory.files))
    throw new Error('runtime component requires measured tree inventory')
  return {kind, contentId: inventory.treeSha256, archive: `${kind}.zip`, archiveSha256: inventory.archiveSha256,
    archiveBytes: inventory.archiveBytes, expandedBytes: inventory.expandedBytes,
    fileCount: inventory.files.length, entry: RUNTIME_ENTRIES[kind], files: inventory.files}
}

function freezeRuntimeManifest(context, args, components) {
  if (RUNTIME_COMPONENT_KINDS.some(kind => !components.some(component => component.kind === kind))) throw new Error('required runtime recipe missing')
  const bindings = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'))
  const observed = { schema: 1, target: 'win32-x86_64', components: Object.fromEntries(components.map(component =>
    [component.kind, {version: bindings.components?.[component.kind]?.version, contentId: component.contentId, archiveSha256: component.archiveSha256}])) }
  fs.writeFileSync(path.join(context.runDirectory, 'component-version-observed.json'), JSON.stringify(observed, null, 2)+'\n')
  const manifest = {schema: 1, domain: RUNTIME_DOMAIN, product_id: context.product.config.product_id,
    bundle_id: context.product.config.bundle_id, app_id: context.appId, target: observed.target,
    components: bindComponentVersions(components, bindings)}
  if (!validateRuntimeManifest(manifest)) throw new Error('invalid generated runtime manifest')
  const componentsDirectory = path.join(context.resourceRoot, 'components')
  fs.mkdirSync(componentsDirectory, {recursive: true})
  const manifestPath = path.join(componentsDirectory, RUNTIME_MANIFEST_FILENAME)
  const keys = context.product.config.update_package_keys || {}
  const raw = JSON.stringify(envelope(manifest, context.payloadSigning, args['payload-private-key'], keys))+'\n'
  if (Buffer.byteLength(raw) > RUNTIME_MANIFEST_LIMIT) throw new Error('runtime envelope exceeds helper input limit')
  fs.writeFileSync(manifestPath, raw, {flag: 'wx'})
  // Preserve the Python distribution descriptor consumed by verifyPython.
  context.runtime = {...context.runtime, manifestPath, manifestSha256: sha256FileSync(manifestPath), keys,
    componentsDirectory, archivesDirectory: path.join(context.runDirectory, ARCHIVES_DIRECTORY)}
  return manifest
}
function runtimeArtifacts(context) {
  const {manifestPath, manifestSha256, archivesDirectory} = context.runtime
  if (sha256FileSync(manifestPath) !== manifestSha256) throw new Error('runtime envelope changed after freezing')
  const wrapped = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const manifest = JSON.parse(Buffer.from(wrapped.manifest, 'base64').toString('utf8'))
  if (!validateRuntimeManifest(manifest) || JSON.stringify(manifest.components) !== JSON.stringify(context.components.components))
    throw new Error('runtime artifact manifest differs from frozen components')
  const expected = manifest.components.map(component => component.archive).sort()
  if (JSON.stringify(fs.readdirSync(archivesDirectory).sort()) !== JSON.stringify(expected)) throw new Error('unexpected runtime delivery material')
  return {manifest_path: manifestPath, components: manifest.components.map(component => {
    const archive = path.join(archivesDirectory, component.archive)
    const stat = fs.lstatSync(archive)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== component.archiveBytes || sha256FileSync(archive) !== component.archiveSha256)
      throw new Error(`runtime delivery archive differs: ${component.kind}`)
    return {kind: component.kind, version: component.version, archiveSha256: component.archiveSha256,
      archiveBytes: component.archiveBytes, path: archive}
  })}
}
function freezeRuntimeProduct(context) {
  if (context.platform !== 'win32') return
  const digest = sha256FileSync(context.runtime.manifestPath)
  if (digest !== context.runtime.manifestSha256) throw new Error('runtime envelope changed before product binding')
  // Installed local builds pin their unsigned manifest just as the compiled
  // helper does. Signed releases and updates still require signature trust.
  context.product.config.runtime_manifest_sha256 = digest
  fs.writeFileSync(context.product.path, JSON.stringify(context.product.config, null, 2) + '\n')
  context.product.sha256 = sha256FileSync(context.product.path)
}
function publishRuntime(context, environment) {
  // Local/candidate builds may use already-published exact dependencies, but must
  // never turn an inherited CI upload command into a publication side effect.
  if (!context.payloadSigning || !context.signingRequired || context.candidate || context.type === 'dev' || context.platform !== 'win32') return
  if (!CI_NAMES.some(name => /^(1|true)$/i.test(environment[name] || ''))) throw new Error('runtime publication is CI-only')
  let command
  try { command = JSON.parse(environment[PUBLISH_COMMAND_ENV] || '') } catch { throw new Error('signed Windows build requires a runtime publication command') }
  if (!Array.isArray(command) || !command.length || command.some(item => typeof item !== 'string' || !item)) throw new Error('invalid runtime publication command')
  runtimeArtifacts(context)
  execFileSync(command[0], [...command.slice(1), '--manifest', context.runtime.manifestPath,
    '--directory', context.runtime.archivesDirectory], {env: environment, stdio: 'inherit', windowsHide: true})
  runtimeArtifacts(context)
}
function runtimeTreeEvidence(directory) {
  const files = state.inventory(directory)
  if (!files.length) throw new Error('bundled runtime tree is empty')
  return { sha256: state.identity(files), files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) }
}
module.exports = { ARCHIVES_DIRECTORY, runtimeTreeEvidence, bindComponentVersions, runtimeComponent, freezeRuntimeManifest, freezeRuntimeProduct, runtimeArtifacts, publishRuntime }
