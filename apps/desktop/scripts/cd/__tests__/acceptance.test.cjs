const test = require('node:test')
const assert = require('node:assert/strict')
const acceptance = require('../acceptance.cjs')

test('Velopack finalization requires installed acceptance and signed distribution artifacts', () => {
  const base = {stage: 'velopack', publishable: true, trust: {level: 'signed-windows'}}
  const app = {signature_valid: true, package_check: {ok: true}}
  const installer = {signature_valid: true, installed_check: {ok: true, retirement: {complete: true}}}
  const velopack = {signed: true}
  const runtime = {manifest_path: '/build/runtime.json', components: [{kind: 'python'}]}
  const result = acceptance.finalResult(base, app, installer, velopack, runtime)
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.artifacts.runtime, runtime)
  assert.throws(() => acceptance.finalResult(base, app, installer, velopack), /runtime delivery artifacts/)
  assert.deepEqual(Object.keys(result.artifacts).sort(), ['app', 'exe', 'runtime', 'velopack'])
  assert.throws(() => acceptance.finalResult(base, app, {...installer, installed_check: {ok: true}}, velopack), /incomplete/)
  assert.throws(() => acceptance.finalResult(base, {...app, package_check: null}, installer, velopack), /incomplete/)
  assert.throws(() => acceptance.finalResult(base, app, installer, null), /incomplete/)
  assert.throws(() => acceptance.finalResult(base, app, installer, {signed: false}), /signed/)
  assert.throws(() => acceptance.finalResult(base, {...app, signature_valid: false}, installer, velopack), /signed/)
  assert.throws(() => acceptance.finalResult(base, app, {...installer, signature_valid: false}, velopack), /signed/)
})

test('macOS finalization requires both accepted artifacts for distribution', () => {
  const base = {stage: 'dmg', publishable: true, release: {version: '0.3.2', channel: 'preview', build_number: '202611251339'}, trust: {level: 'signed-macos'}}
  const app = {trust: {team: 'fixture'}, package_check: {ok: true}}
  const installer = {path: 'ScholarSeed.dmg', sha256: 'digest', signature_valid: true, trust: {team: 'mounted'}, installed_check: {status: 'passed', source: 'mounted-dmg', detached: true, sha256: 'digest', package_check: {ok: true}, update_archive: {size: 200, entries: 3, metadata: 100, expanded: 400}}}
  assert.throws(() => acceptance.finalResult(base, app, {...installer, installed_check: null}), /DMG acceptance/)
  assert.throws(() => acceptance.finalResult(base, app, {...installer, sha256: 'changed'}), /DMG acceptance/)
  assert.throws(() => acceptance.finalResult(base, app, {...installer, installed_check: {...installer.installed_check, update_archive: undefined}}), /measured update ZIP/)
  assert.throws(() => acceptance.finalResult(base, app, installer), /ZIP acceptance/)
  assert.throws(
    () => acceptance.finalResult({ ...base, release: { application_layout: 'directory' } }, app, installer),
    /ZIP acceptance/
  )
  const zip = {
    path: 'scholarseed-update.zip', sha256: 'a'.repeat(64), sha512: 'b'.repeat(128),
    size: 200, archive_budget: installer.installed_check.update_archive,
    signature_valid: true, stapled: true,
  }
  const accepted = acceptance.finalResult(base, app, installer, undefined, undefined, zip)
  const versions = accepted.artifacts.macos_update_zip.component_versions
  assert.deepEqual(accepted, {
    ...base, status: 'passed', artifacts: {app, dmg: installer, macos_update_zip: {...zip, component_versions: versions}}, trust: {...base.trust, ...installer.trust},
  })
  const runtimeSources = {
    browser: require('../browser.json').version,
    codex: require('../../../../../scripts/vendor/codex/manifest.json').version,
    electron: require('../../../package.json').devDependencies.electron,
    python: require('../../../../../scripts/vendor/python-build-standalone/manifest.json').python,
    texlive: require('../../../../../scripts/vendor/texlive/manifest.json').texlive,
  }
  assert.deepEqual(Object.keys(versions).sort(), Object.keys(runtimeSources))
  for (const [kind, upstream] of Object.entries(runtimeSources)) {
    assert.ok(versions[kind].startsWith(upstream + '-r'), kind)
    assert.match(versions[kind], /-r[1-9][0-9]*$/)
  }
  for (const release of [
    {...base.release, build_number: '202611261200'},
    {...base.release, channel: 'release'},
  ]) {
    const next = acceptance.finalResult({...base, release}, app, installer, undefined, undefined, zip)
      .artifacts.macos_update_zip.component_versions
    assert.deepEqual(next, versions)
  }
  for (const release of [{...base.release, channel: '../preview'}, {...base.release, build_number: 'not-a-build'}]) {
    assert.throws(() => acceptance.finalResult({...base, release}, app, installer, undefined, undefined, zip), /release identity/)
  }
  const localBuild = { ...base, publishable: false }
  assert.deepEqual(acceptance.finalResult(localBuild, app, installer).artifacts, { app, dmg: installer })
  assert.throws(() => acceptance.finalResult(localBuild, app, installer, undefined, undefined, zip), /Unexpected/)
})

test('kernel installation mutex refuses an active owner and releases its lease',{skip:process.platform!=='win32'},async()=>{
  const release=await acceptance.installationMutex()
  try { await assert.rejects(acceptance.installationMutex(),/acceptance is busy/) } finally { await release() }
  await (await acceptance.installationMutex())()
})
