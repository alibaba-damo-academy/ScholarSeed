const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {execFileSync} = require('node:child_process')
const {developmentPython} = require('../../../../../scripts/shared/python.cjs')
const {adHocOptions} = require('../sign.cjs')
const {signAsync} = require('../osx-sign.cjs')
const {signableIgnore} = require('../macho.cjs')
const {hashFile} = require('../../shared/build-state.cjs')
const {hostArch} = require('../../shared/target.cjs')
const {registryCommand} = require('./signing.fixture.cjs')

const darwin = process.platform === 'darwin'
const repo = path.resolve(__dirname, '../../../../..')
const pythonFile = 'Contents/Resources/backend/python/bin/python'
const texFile = 'Contents/Resources/backend/texlive/bin/tex'
const pythonAlias = 'Contents/Resources/backend/python/bin/python3'
const mantleFramework = 'Contents/Frameworks/Mantle.framework'
const mantleFile = mantleFramework + '/Versions/A/Mantle'

test('Mach-O content proofs preserve signed files and reject unexpected overlay members', {skip: !darwin}, () => {
  execFileSync(developmentPython(repo, process.env.VENV), ['-I', '-S', '-B', path.join(__dirname, 'signed_runtime_test.py')], {stdio: 'pipe'})
})

test('reuse signed runtimes while signing the updater frameworks and outer bundle on every build', {skip: !darwin}, async t => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac-sign-build-')))
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}))
  const cache = path.join(temporary, 'cache')
  for (const [name, value] of Object.entries({
    SCHOLARSEED_MAC_SIGN_CACHE: cache, SCHOLARSEED_MAC_SIGN_REGISTRY_COMMAND: undefined,
  })) {
    const former = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    t.after(() => {
      if (former === undefined) delete process.env[name]
      else process.env[name] = former
    })
  }
  // Only substitute the Developer ID policy. The helper, store, signing walker,
  // codesign invocations, restored bytes and final bundle seal are real.
  let policyVersion = 'policy-1'
  t.mock.method(require('../mac-sign-policy.cjs'), 'createRuntimeSigningPolicy', ({app}) => ({
    forGroup: ({files}) => ({
      digest: policyVersion,
      verify() {
        for (const name of files)
          execFileSync('/usr/bin/codesign', ['--verify', '--strict', path.join(app, name)])
      },
    }),
  }))
  const {withSignedRuntimes} = require('../mac-sign-cache.cjs')
  const compile = value => {
    const file = path.join(temporary, 'native-' + value)
    execFileSync('/usr/bin/clang', ['-x', 'c', '-', '-o', file], {input: 'int main(void) { return ' + value + '; }'})
    return file
  }
  const original = compile(0), changed = compile(1)
  const frozen = {repo, arch: hostArch(), appId: 'org.example.cache', lane: 'distribution',
    platform: 'darwin', signingRequired: true, runDirectory: temporary}
  const baseIgnore = signableIgnore()
  await assert.rejects(
    withSignedRuntimes({}, {...frozen, arch: '../arm64'}, baseIgnore, () => assert.fail('invalid frozen target')),
    /unsupported desktop target/
  )
  async function build(label, tex = original, concurrentWinner) {
    const app = path.join(temporary, label, 'Example.app')
    for (const [file, binary] of [[pythonFile, original], [texFile, tex], ['Contents/MacOS/Example', original]]) {
      fs.mkdirSync(path.dirname(path.join(app, file)), {recursive: true})
      fs.copyFileSync(binary, path.join(app, file))
    }
    const framework = path.join(app, mantleFramework)
    fs.mkdirSync(path.join(framework, 'Versions/A/Resources'), {recursive: true})
    fs.copyFileSync(original, path.join(app, mantleFile))
    fs.symlinkSync('A', path.join(framework, 'Versions/Current'))
    fs.symlinkSync('Versions/Current/Mantle', path.join(framework, 'Mantle'))
    fs.symlinkSync('Versions/Current/Resources', path.join(framework, 'Resources'))
    fs.writeFileSync(path.join(framework, 'Resources/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>org.example.Mantle</string>
      <key>CFBundlePackageType</key><string>FMWK</string>
      <key>CFBundleExecutable</key><string>Mantle</string>
      <key>CFBundleVersion</key><string>1</string></dict></plist>`)
    fs.symlinkSync('python', path.join(app, pythonAlias))
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>org.example.cache</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleExecutable</key><string>Example</string>
      <key>CFBundleVersion</key><string>1</string></dict></plist>`)
    fs.writeFileSync(path.join(app, 'Contents/Resources/app.js'), 'module.exports = ' + JSON.stringify(label))
    const signed = []
    let passes = 0
    await withSignedRuntimes({app}, frozen, baseIgnore, async ignore => {
      if (++passes === 1 && concurrentWinner) await concurrentWinner()
      const options = adHocOptions(app, ignore)
      const perFile = options.optionsForFile
      await signAsync({...options, optionsForFile: filename => {
        signed.push(path.relative(app, filename))
        const settings = perFile(filename)
        // Give this cold signer distinct, valid ad hoc bytes to exercise the
        // same re-sealing path as two distinct secure timestamps in production.
        if (concurrentWinner && filename.includes('/backend/'))
          settings.additionalArguments = ['--identifier', 'org.example.alternate']
        return settings
      }})
    })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app])
    assert.ok(signed.includes(''), 'fresh outer signature')
    return {signed, python: hashFile(path.join(app, pythonFile)), tex: hashFile(path.join(app, texFile))}
  }

  const cold = await build('cold')
  assert.ok(cold.signed.includes(pythonFile))
  assert.ok(cold.signed.includes(texFile))
  const hot = await build('app-only')
  assert.ok(hot.signed.includes(mantleFramework) || hot.signed.includes(mantleFile), 'fresh updater framework signature')
  assert.deepEqual(hot.signed.filter(name => name.includes('/backend/')), [])
  assert.equal(hot.python, cold.python)
  assert.equal(hot.tex, cold.tex)
  const oneMiss = await build('changed-tex', changed)
  assert.deepEqual(oneMiss.signed.filter(name => name.includes('/backend/')), [texFile])
  assert.equal(oneMiss.python, cold.python)
  assert.notEqual(oneMiss.tex, cold.tex)
  policyVersion = 'policy-2'
  const rotated = await build('changed-policy')
  assert.ok(rotated.signed.includes(pythonFile))
  assert.ok(rotated.signed.includes(texFile))

  policyVersion = 'race'
  let winner
  const loser = await build('loser', original, async () => { winner = await build('winner') })
  assert.equal(loser.signed.filter(name => name === '').length, 2, 'restore winner and re-sign outer bundle')
  assert.equal(loser.python, winner.python)
  assert.equal(loser.tex, winner.tex)

  const registry = path.join(temporary, 'registry')
  fs.mkdirSync(registry, {mode: 0o700})
  process.env.SCHOLARSEED_MAC_SIGN_REGISTRY_COMMAND = registryCommand(registry)
  const sharedCold = await build('shared-cold')
  assert.ok(sharedCold.signed.includes(pythonFile))
  assert.ok(sharedCold.signed.includes(texFile))
  process.env.SCHOLARSEED_MAC_SIGN_CACHE = path.join(temporary, 'second-runner')
  const sharedHit = await build('fresh-runner')
  const localHit = await build('fresh-runner-app-only')
  assert.equal(fs.readFileSync(path.join(registry, 'calls'), 'utf8'), 'fetch 3\nfetch 3\npublish 0\npublish 0\nfetch 0\nfetch 0\nconfirm 0\nconfirm 0\n')
  for (const kind of ['python', 'texlive']) {
    const version = require('../mac-component-versions.cjs').macComponentVersions()[kind]
    const receipt = path.join(registry, 'darwin-' + (frozen.arch === 'x64' ? 'x86_64' : frozen.arch), kind, version, 'receipt.json')
    assert.match(JSON.parse(fs.readFileSync(receipt)).inputSha256, /^[a-f0-9]{64}$/)
  }
  for (const hit of [sharedHit, localHit]) {
    assert.ok(hit.signed.includes(mantleFramework) || hit.signed.includes(mantleFile), 'fresh updater framework signature')
    assert.deepEqual(hit.signed.filter(name => name.includes('/backend/')), [])
    assert.equal(hit.python, sharedCold.python)
    assert.equal(hit.tex, sharedCold.tex)
  }
})
