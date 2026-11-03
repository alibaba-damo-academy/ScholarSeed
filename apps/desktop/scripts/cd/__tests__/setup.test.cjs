const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {spawnSync} = require('node:child_process')
const {rootBudget, messages, legacyPolicy, stageSetup, compileSetup, verifyDependencies} = require('../setup.cjs')
test('installer path budget covers update staging and root backup', () => {
  const name = 'scholarseed-0.2.0-build.202610170000-full.nupkg'
  const relative = 'very/'.repeat(20)+'program.exe'
  const prefix = 'packages/VelopackTemp/tmp_'+'0'.repeat(16)+'/'
  assert.equal(rootBudget([{path:'lib/app/'+relative}],[],name),259-prefix.length-relative.length-1-17)
})
test('installer path budget includes component preparation and archive temporary names', () => {
  const c = {kind:'python',version:'3.12.12-r1',files:[{path:'深'.repeat(120)+'.py'}]}
  const relative = `runtime/python/.prepare-0000000000/${c.files[0].path}`
  assert.equal(rootBudget([], [c], 'a.nupkg'),259-relative.length-1-17)
  assert.throws(() => rootBudget([], [{...c,files:[{path:'x'.repeat(259)}]}], 'a.nupkg'))
})
test('installer freezes complete English and Chinese resources', () => {
  const resources = messages()
  assert.deepEqual(Object.keys(resources.en),Object.keys(resources.zh))
  for (const m of Object.values(resources)) {
    for (const key of ['legacyRemoval','legacyUnknown','title','heading','description','directory','browse','install','cancel','existing','invalid','failed','unsafe','installing','preparing','migration','migrating','migrationUnsupported','migrationRunning','migrationIncomplete','migrationIdentity',
      'invalidPath','tooLong','invalidName','relocation','reparse','protected','drive','notEmpty','notWritable','permission','inspection','riskChanged','launch','risk','riskEntry','riskTitle','riskSilent','riskQuestion','riskOwner','riskAccess']) {
      assert.equal(typeof m[key], 'string', key)
      assert.ok(m[key].trim().length, key)
      assert.equal(m[key].includes('\0'), false, key)
    }
  }
})

test('installer directory templates preserve paths, diagnostics and localized risk reasons', () => {
  const parameters = value => [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]).sort()
  for (const m of Object.values(messages())) {
    for (const key of ['invalidPath','tooLong','invalidName','relocation','reparse','protected','drive','notEmpty','notWritable','permission','inspection','riskChanged','launch'])
      assert.deepEqual(parameters(m[key]), key === 'relocation' ? ['detail', 'path', 'registeredPath'] : ['detail', 'path'], key)
    assert.deepEqual(parameters(m.legacyRemoval), ['detail', 'path'])
    assert.deepEqual(parameters(m.legacyUnknown), [])
    assert.deepEqual(parameters(m.risk), ['path'])
    assert.deepEqual(parameters(m.riskEntry), ['mask', 'path', 'principal', 'reason'])
    for (const key of ['riskTitle','riskSilent','riskQuestion','riskOwner','riskAccess']) assert.deepEqual(parameters(m[key]), [], key)
    assert.match(m.riskSilent, /--accept-directory-risk/)
    assert.notEqual(m.riskOwner, m.riskAccess)
  }
})

test('installer freezes only the measured original NSIS release', () => {
  const original = require('../legacy.json')
  const policy = legacyPolicy()
  assert.equal(policy.build, '202610091639')
  assert.equal(policy.commit, 'b8a938849f0be71d7b3d92830b8a4988722435d7')
  for (const field of ['installerSha256', 'uninstallerSha256', 'productSha256', 'asarSha256', 'inventorySha256']) {
    for (const invalid of [undefined, '', '0'.repeat(64), 'X'.repeat(64)])
      assert.throws(() => legacyPolicy({...original, [field]: invalid}))
  }
  assert.throws(() => legacyPolicy({...original, build: '202610091638'}))
  assert.throws(() => legacyPolicy({...original, commit: 'a'.repeat(40)}))
  assert.equal(Object.hasOwn(policy, 'source'), false)
})

test('Windows CRLF checkout preserves both reviewed migration inventories', context => {
  const expected = require('../legacy.json').inventorySha256
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-inventory-checkout-'))
  context.after(() => fs.rmSync(temporary, {recursive: true, force: true}))
  for (const filename of ['legacy-files.json', '../../updater/cmd/setup/legacy-files.json']) {
    const contents = fs.readFileSync(path.join(sourceDirectory, filename))
    if (filename === 'legacy-files.json') assert.equal(crypto.createHash('sha256').update(contents).digest('hex'), expected)
    else assert.deepEqual(contents, Buffer.from('[]\n'))
    const attributes = spawnSync('git', ['check-attr', 'eol', '--', filename], {cwd: sourceDirectory, encoding: 'utf8', windowsHide: true})
    assert.equal(attributes.status, 0, attributes.stderr)
    assert.match(attributes.stdout, /: eol: lf\s*$/)
    const checkout = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'checkout-index',
      `--prefix=${temporary.replaceAll('\\', '/')}/`, '--', filename], {cwd: sourceDirectory, encoding: 'utf8', windowsHide: true})
    assert.equal(checkout.status, 0, checkout.stderr)
    const relative = path.relative(path.resolve(sourceDirectory, '../../../..'), path.resolve(sourceDirectory, filename))
    assert.deepEqual(fs.readFileSync(path.join(temporary, relative)), contents)
  }
})

test('installer dependency policy rejects unreviewed internal and external packages', () => {
  const entry = 'scholarseed.local/desktop/updater/cmd/setup'
  const helper = 'scholarseed.local/desktop/updater/handoff'
  const policy = 'scholarseed.local/desktop/updater/internal/security'
  assert.doesNotThrow(() => verifyDependencies(`${helper}\n${entry}\n${policy}`))
  for (const dependencies of ['', entry, `${entry}\n${helper}\nexample.com/module`, `${entry}\n${helper}\nscholarseed.local/desktop/updater/extra`])
    assert.throws(() => verifyDependencies(dependencies), /dependencies differ/)
})

test('installer staging preserves module layout and exact embedded input', context => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-setup-staging-'))
  context.after(() => fs.rmSync(temporary, {recursive: true, force: true}))
  const goRoot = path.join(temporary, 'sdk')
  fs.mkdirSync(goRoot)
  fs.writeFileSync(path.join(goRoot, 'LICENSE'), 'test license')
  const payload = Buffer.from('test payload')
  const source = stageSetup(temporary, goRoot, payload)
  assert.ok(fs.existsSync(path.join(source, 'handoff/admission_windows.go')))
  assert.ok(fs.existsSync(path.join(source, 'internal/security/evaluate.go')))
  assert.ok(fs.existsSync(path.join(source, 'cmd/setup/permission_windows.go')))
  assert.deepEqual(fs.readFileSync(path.join(source, 'cmd/setup/payload.bin')), payload)
  assert.deepEqual(fs.readFileSync(path.join(source, 'cmd/setup/legacy-files.json')), fs.readFileSync(path.join(sourceDirectory, 'legacy-files.json')))
  assert.equal(fs.readFileSync(path.join(source, 'cmd/setup/license.txt'), 'utf8'), 'test license')
  assert.ok(fs.existsSync(path.join(source, 'go.mod')))
})

test('isolated Windows installer compiles and verifies its embedded payload', {
  skip: process.platform !== 'win32' || !process.env.SCHOLARSEED_SETUP_TEST_GO,
  timeout: 300_000,
}, context => {
  const go = process.env.SCHOLARSEED_SETUP_TEST_GO
  const goRoot = path.dirname(path.dirname(go))
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-setup-compile-'))
  context.after(() => fs.rmSync(temporary, {recursive: true, force: true}))
  const environment = {...process.env, GOROOT: goRoot, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off',
    GOPROXY: 'off', GOSUMDB: 'off', GOFLAGS: '', GO111MODULE: 'on', CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64',
    GOPATH: path.join(temporary, 'path'), GOMODCACHE: path.join(temporary, 'modules'), GOCACHE: path.join(os.tmpdir(), 'scholarseed-setup-test-go-cache')}
  const version = spawnSync(go, ['version'], {env: environment, encoding: 'utf8', windowsHide: true})
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), `go version ${require('../../../updater/toolchain.json').version} windows/amd64`)
  const payload = Buffer.from('isolated compiler payload probe')
  const source = stageSetup(temporary, goRoot, payload)
  const policy = {appId: 'scholarseed', maxRootUnits: 120, messages: messages(), legacy: legacyPolicy(),
    payloadSha256: crypto.createHash('sha256').update(payload).digest('hex')}
  assert.ok(fs.statSync(compileSetup(source, temporary, go, environment, policy)).size > payload.length)
  assert.throws(() => compileSetup(source, temporary, go, environment, {...policy, payloadSha256: '0'.repeat(64)}), /payload check failed|native compiler failed/)
})

test('installer budget reserves version cache identity publication paths', () => {
  const component = { kind: 'texlive', version: '2026-r3', files: [] }
  const longest = `runtime/cache/texlive/2026-r3/identity-00000000-0000-0000-0000-000000000000.tmp`
  assert.equal(rootBudget([], [component], 'a.nupkg'), 259 - longest.length - 1 - 17)
  assert.throws(() => rootBudget([], [{ ...component, version: '../outside' }], 'a.nupkg'), /version/)
})
