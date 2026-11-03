const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { stageOfficeComponent, OFFICE_BUILD_DIRECTORY } = require('../office-assets.cjs')
const { officeContentId } = require('../../cd/payload.cjs')
const { developmentPython } = require('../../../../../scripts/shared/python.cjs')

const NOTICE = 'THIRD_PARTY_NOTICES.md'
const ROOT = path.join('src', 'renderer', 'public', 'office')
const REPO = path.resolve(sourceDirectory, '../../../..')
const PYTHON = process.env.TEST_PYTHON || developmentPython(REPO, process.env.VENV, { context: process.env.CI ? 'ci' : 'local' })

test('reviewed Office tree binding covers tracked metadata and pinned vendor files', () => {
  const desktop = path.resolve(sourceDirectory, '../..')
  const root = path.join(desktop, ROOT)
  const manifestBytes = fs.readFileSync(path.join(root, OFFICE_BUILD_DIRECTORY, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const notice = Buffer.from(fs.readFileSync(path.join(root, NOTICE), 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1')
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
  const tree = [
    [NOTICE, 'file', notice.length, digest(notice)],
    [OFFICE_BUILD_DIRECTORY + '/', 'directory', 0, digest(Buffer.alloc(0))],
    [`${OFFICE_BUILD_DIRECTORY}/manifest.json`, 'file', manifestBytes.length, digest(manifestBytes)],
    ...Object.entries(manifest.files).map(([name, expected]) =>
      [`${OFFICE_BUILD_DIRECTORY}/${name}`, 'file', expected.bytes, expected.sha256]),
  ].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const bindings = JSON.parse(fs.readFileSync(path.join(desktop, 'runtime', 'versions.json'), 'utf8'))
  assert.equal(digest(JSON.stringify(tree)), bindings.components.office.contentId,
    'Office metadata or vendor changes require a reviewed component revision and measured tree/ZIP bindings')
})

function fixture(t, newline) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-office-')))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const desktop = path.join(temporary, 'desktop')
  const root = path.join(desktop, ROOT)
  const build = path.join(root, OFFICE_BUILD_DIRECTORY)
  fs.mkdirSync(build, { recursive: true })
  const asset = Buffer.from([0, 255, 10, 13, 10, 42])
  fs.writeFileSync(path.join(build, 'asset.bin'), asset)
  const manifest = Buffer.from(JSON.stringify({ build_id: 'zeta-24-2-20250513', files: {
    'asset.bin': { bytes: asset.length, sha256: crypto.createHash('sha256').update(asset).digest('hex') },
  } }) + '\n')
  fs.writeFileSync(path.join(build, 'manifest.json'), manifest)
  const notice = Buffer.from(['License ©', 'Redistribution terms unchanged.', ''].join(newline))
  fs.writeFileSync(path.join(root, NOTICE), notice)
  return { temporary, desktop, root, asset, manifest, notice }
}

test('LF and CRLF checkouts produce identical Office tree and ZIP without changing source or vendor bytes', async t => {
  const results = []
  for (const newline of ['\n', '\r\n']) {
    const f = fixture(t, newline)
    const stage = await stageOfficeComponent(f.desktop, path.join(f.temporary, 'stage'))
    assert.deepEqual(fs.readFileSync(path.join(f.root, NOTICE)), f.notice)
    assert.deepEqual(fs.readFileSync(path.join(stage, NOTICE)), Buffer.from('License ©\r\nRedistribution terms unchanged.\r\n'))
    assert.deepEqual(fs.readFileSync(path.join(stage, OFFICE_BUILD_DIRECTORY, 'asset.bin')), f.asset)
    assert.deepEqual(fs.readFileSync(path.join(stage, OFFICE_BUILD_DIRECTORY, 'manifest.json')), f.manifest)
    const archive = path.join(f.temporary, 'office.zip')
    execFileSync(PYTHON, ['-I', '-B', path.join(sourceDirectory, '../cd/payload.py'), '--root', stage,
      '--output', archive, '--entry', `${OFFICE_BUILD_DIRECTORY}/manifest.json`, '--reproducible'])
    const inventory = JSON.parse(execFileSync(PYTHON, ['-I', '-B', path.join(sourceDirectory, '../cd/archive_inventory.py'), '--files', archive]))
    results.push({ content: await officeContentId(stage), inventory, bytes: fs.readFileSync(archive) })
  }
  assert.deepEqual(results[0], results[1])
})

test('Office staging preserves complete-tree validation and refuses an existing output', async t => {
  const f = fixture(t, '\n')
  const stage = path.join(f.temporary, 'stage')
  fs.writeFileSync(path.join(f.root, 'unexpected.txt'), 'not reviewed')
  await assert.rejects(stageOfficeComponent(f.desktop, stage), /unexpected frozen Office asset/)
  assert.equal(fs.existsSync(stage), false)
  fs.unlinkSync(path.join(f.root, 'unexpected.txt'))
  await stageOfficeComponent(f.desktop, stage)
  await assert.rejects(stageOfficeComponent(f.desktop, stage), { code: 'EEXIST' })
})

test('Office notice checkout uses reviewed CRLF independently of core.autocrlf', t => {
  const f = fixture(t, '\n')
  const repo = path.join(f.temporary, 'git')
  const relative = 'apps/desktop/src/renderer/public/office/THIRD_PARTY_NOTICES.md'
  const filename = path.join(repo, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.copyFileSync(path.resolve(sourceDirectory, '../../../../.gitattributes'), path.join(repo, '.gitattributes'))
  fs.writeFileSync(filename, f.notice)
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git(['init'])
  git(['-c', 'core.safecrlf=false', 'add', '.gitattributes', relative])
  for (const setting of ['false', 'true', 'input']) {
    fs.unlinkSync(filename)
    git(['-c', `core.autocrlf=${setting}`, 'checkout-index', '--all', '--force'])
    assert.deepEqual(fs.readFileSync(filename), Buffer.from(f.notice.toString().replaceAll('\n', '\r\n')))
  }
})
