// Installer presentation only; the embedded official Setup owns installation.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { withCompiler, run } = require('./compiler.cjs')
const windows = require('./windows-sign.cjs')
const legacy = require('./legacy.json')
const { texliveCacheRelativePaths } = require('../../runtime/texlive.cjs')
const MODULE = path.resolve(__dirname, '../../updater')
const PATH_LIMIT = 259
const SETUP_PACKAGE = './cmd/setup'
const SETUP_DEPENDENCIES = ['scholarseed.local/desktop/updater/cmd/setup', 'scholarseed.local/desktop/updater/handoff', 'scholarseed.local/desktop/updater/internal/security']
const digest = data => crypto.createHash('sha256').update(data).digest('hex')
function messages() {
  return Object.fromEntries(['en', 'zh'].map(language => [language,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/localization/locales', language, 'native.json'))).installer]))
}
function rootBudget(files, components, packageName) {
  const paths = ['packages/' + packageName]
  for (const file of files) {
    if (!file.path.startsWith('lib/app/')) continue
    const relative = file.path.slice('lib/app/'.length)
    for (const prefix of ['current/', 'packages/VelopackTemp/tmp_' + '0'.repeat(16) + '/']) paths.push(prefix + relative)
  }
  for (const component of components) {
    if (component.kind === 'texlive') {
      paths.push(...texliveCacheRelativePaths(component.version).map(relative => `runtime/${relative}`))
    }
    paths.push(`runtime/.archives/${component.kind}-${component.version}.zip.part-000000000000`)
    for (const prefix of [`runtime/${component.kind}/${component.version}/`, `runtime/${component.kind}/.prepare-0000000000/`]) {
      paths.push(prefix + '.scholarseed-component.json')
      for (const file of component.files) paths.push(prefix + file.path)
    }
  }
  // JavaScript length measures UTF-16 code units, matching the native policy.
  const longest = paths.reduce((longest, value) => Math.max(longest, value.length), 0)
  const result = PATH_LIMIT - longest - 1 - 17
  if (result < 4) throw new Error('package paths leave no valid installation root')
  return result
}
function configuration(frozen, payload, files) {
  const raw = fs.readFileSync(frozen.runtime.manifestPath)
  if (digest(raw) !== frozen.runtime.manifestSha256) throw new Error('installer runtime manifest changed')
  const runtime = JSON.parse(Buffer.from(JSON.parse(raw).manifest, 'base64'))
  if (!Array.isArray(runtime.components) || !runtime.components.length) throw new Error('installer runtime inventory missing')
  return {appId: frozen.appId, payloadSha256: digest(payload), maxRootUnits: rootBudget(files, runtime.components, `${frozen.appId}-${frozen.version}-build.${frozen.product.config.build_number}-full.nupkg`), messages: messages(), legacy: legacyPolicy()}
}
function legacyPolicy(source = legacy) {
  if (digest(fs.readFileSync(path.join(__dirname, 'legacy-files.json'))) !== source.inventorySha256)
    throw new Error('original NSIS inventory changed')
  if (source.build !== '202610091639' || source.commit !== 'b8a938849f0be71d7b3d92830b8a4988722435d7')
    throw new Error('unsupported NSIS migration source')
  for (const key of ['installerSha256', 'uninstallerSha256', 'productSha256', 'asarSha256', 'inventorySha256']) {
    if (!/^[a-f0-9]{64}$/.test(source[key]) || /^0+$/.test(source[key]))
      throw new Error('missing original NSIS release digest: ' + key)
  }
  const {build, commit, uninstallerSha256, productSha256, asarSha256, inventorySha256} = source
  return {build, commit, uninstallerSha256, productSha256, asarSha256, inventorySha256}
}
async function wrapSetup(filename, frozen, args, environment, files, branding) {
  const payload = fs.readFileSync(filename)
  const policy = configuration(frozen, payload, files)
  const publisher = frozen.product.config.expected_windows_publisher
  if (frozen.signingRequired) windows.verify(filename, publisher)
  return withCompiler({runDirectory: frozen.runDirectory, goArchive: args['go-archive'], environment}, async ({temporary, go, goRoot, env}) => {
    run(go, ['vet', './cmd/setup'], env, MODULE)
    run(go, ['test', '-count=1', '-timeout=5m', './cmd/setup'], env, MODULE)
    const source = stageSetup(temporary, goRoot, payload)
    const compiled = compileSetup(source, temporary, go, env, policy)
    branding(compiled, {icon: frozen.icon, version: frozen.version, productName: frozen.productName,
      originalFilename: path.basename(filename)})
    if (frozen.signingRequired) {await windows.signFile(compiled);windows.verify(compiled, publisher)}
    // Replace only the build-owned output; nupkg/full/delta and feeds stay official.
    if (digest(fs.readFileSync(filename)) !== policy.payloadSha256) throw new Error('official installer changed during wrapping')
    fs.copyFileSync(compiled, filename)
    return {engine_sha256: policy.payloadSha256, max_root_units: policy.maxRootUnits, sha256: digest(fs.readFileSync(filename))}
  })
}
function stageSetup(temporary, goRoot, payload) {
  run(process.execPath, [path.resolve(__dirname, '../pre/security.cjs'), '--check'], process.env, path.resolve(MODULE, '../../..'))
  legacyPolicy()
  const source = path.join(temporary, 'setup')
  fs.mkdirSync(source)
  for (const directory of ['cmd/setup', 'handoff', 'internal/security']) {
    const target = path.join(source, directory)
    fs.mkdirSync(target, {recursive: true})
    for (const file of fs.readdirSync(path.join(MODULE, directory))) {
      if (file.endsWith('.go') || file === 'logo.png') fs.copyFileSync(path.join(MODULE, directory, file), path.join(target, file))
    }
  }
  const entry = path.join(source, 'cmd/setup')
  fs.copyFileSync(path.join(__dirname, 'legacy-files.json'), path.join(entry, 'legacy-files.json'))
  fs.copyFileSync(path.join(MODULE, 'go.mod'), path.join(source, 'go.mod'))
  fs.copyFileSync(path.join(goRoot, 'LICENSE'), path.join(entry, 'license.txt'))
  fs.writeFileSync(path.join(entry, 'payload.bin'), payload, {flag: 'wx'})
  return source
}
function verifyDependencies(dependencies) {
  const actual = dependencies.trim().split(/\s+/).sort()
  if (JSON.stringify(actual) !== JSON.stringify(SETUP_DEPENDENCIES))
    throw new Error('installer dependencies differ from the reviewed setup and handoff packages')
}
function compileSetup(source, temporary, go, env, policy) {
  verifyDependencies(run(go, ['list', '-deps', '-f', '{{if not .Standard}}{{.ImportPath}}{{end}}', SETUP_PACKAGE], env, source))
  const compiled = path.join(temporary, 'ScholarSeed-Setup.exe')
  const encoded = Buffer.from(JSON.stringify(policy)).toString('base64')
  run(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -H=windowsgui -X main.buildConfiguration=${encoded}`, '-o', compiled, SETUP_PACKAGE], env, source)
  if (run(compiled, ['--check-policy'], env) !== policy.payloadSha256) throw new Error('installer payload check failed')
  return compiled
}
module.exports = {wrapSetup, configuration, rootBudget, messages, legacyPolicy, stageSetup, compileSetup, verifyDependencies}
