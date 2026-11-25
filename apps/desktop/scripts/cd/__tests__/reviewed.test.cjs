const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { restoreReviewedArchive } = require('../windows-runtime.cjs')
const cache = require('../../shared/component-cache.cjs')
const { developmentPython } = require('../../../../../scripts/shared/python.cjs')
const REPO = path.resolve(__dirname, '../../../../..')
const PYTHON = process.env.TEST_PYTHON || developmentPython(REPO, process.env.VENV, {context: process.env.CI ? 'ci' : 'local'})

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-reviewed-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const reviewed = path.join(root, 'reviewed.zip'), output = path.join(root, 'rebuilt.zip')
  execFileSync(PYTHON, ['-I', '-B', '-c', `import sys,zipfile
for filename, method in zip(sys.argv[1:], [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]):
 with zipfile.ZipFile(filename, 'w', compression=method) as archive:
  archive.writestr('powershell/pwsh.exe', b'actual executable bytes' * 100)
`, reviewed, output])
  const measured = file => cache.measure(PYTHON, file, process.env, 'powershell', true)
  const original = measured(output), canonical = measured(reviewed)
  assert.equal(original.treeSha256, canonical.treeSha256)
  assert.notEqual(original.archiveSha256, canonical.archiveSha256)
  const bindings = {schema: 1, target: 'win32-x86_64', components: {powershell: {
    version: '7.6.6-r2', contentId: canonical.treeSha256, archiveSha256: canonical.archiveSha256}}}
  const environment = {...process.env, SCHOLARSEED_RUNTIME_FETCH_COMMAND: JSON.stringify([process.execPath, '-e',
    'require("node:fs").copyFileSync(process.argv[1], process.argv[process.argv.indexOf("--output") + 1])', reviewed, '--'])}
  return {root, output, reviewed, original, canonical, bindings, environment}
}
test('same tree with different ZIP bytes restores the exact reviewed archive before cache publication', t => {
  const f = fixture(t)
  const inventory = restoreReviewedArchive('powershell', f.output, f.original, PYTHON, f.environment, f.bindings)
  assert.equal(inventory.archiveSha256, f.canonical.archiveSha256)
  assert.deepEqual(fs.readFileSync(f.output), fs.readFileSync(f.reviewed))
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['rebuilt.zip', 'reviewed.zip'])
})
test('changed contents keep the new build; an old reviewed archive cannot replace it', t => {
  const f = fixture(t)
  f.bindings.components.powershell.contentId = 'f'.repeat(64)
  assert.equal(restoreReviewedArchive('powershell', f.output, f.original, PYTHON, f.environment, f.bindings), f.original)
  assert.equal(cache.measure(PYTHON, f.output, process.env, 'powershell').archiveSha256, f.original.archiveSha256)
})
test('unconfigured standalone builds retain strict version binding', t => {
  const f = fixture(t)
  assert.equal(restoreReviewedArchive('powershell', f.output, f.original, PYTHON, {}, f.bindings), f.original)
})
test('a corrupt downloaded archive fails without replacing the rebuilt ZIP or leaving temporary material', t => {
  const f = fixture(t)
  fs.appendFileSync(f.reviewed, 'corrupt')
  assert.throws(() => restoreReviewedArchive('powershell', f.output, f.original, PYTHON, f.environment, f.bindings), /reviewed runtime archive differs/)
  assert.equal(cache.measure(PYTHON, f.output, process.env, 'powershell').archiveSha256, f.original.archiveSha256)
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['rebuilt.zip', 'reviewed.zip'])
})
