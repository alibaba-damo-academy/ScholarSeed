const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { planStages } = require('../ci/test.cjs')

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT_EXTENSIONS = new Set(['.cjs', '.mjs', '.py', '.sh', '.ps1', '.psm1'])
const DOMAINS = ['pre', 'dev', 'ci', 'cd', 'shared']

test('repository scripts expose ops and the bounded distribution contract entry', () => {
  const directory = path.join(ROOT, 'scripts')
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const executable = entries.filter(entry => entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name)))
  assert.deepEqual(executable.map(entry => entry.name).sort(), ['desktop.cjs', 'ops-cli.cjs'])
  for (const domain of DOMAINS) assert.ok(fs.statSync(path.join(directory, domain)).isDirectory(), domain)
})

test('Desktop implementations remain under their Owner and tests stay in neighboring test directories', () => {
  const directory = path.join(ROOT, 'apps/desktop/scripts')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!entry.isFile() || !SCRIPT_EXTENSIONS.has(path.extname(entry.name)), entry.name)
  }
  for (const root of ['scripts', 'apps/desktop/scripts']) {
    for (const filename of fs.readdirSync(path.join(ROOT, root), { recursive: true })) {
      if (!/(?:\.test\.(?:cjs|mjs|ps1)|(?:^|[\\/])(?:test_[^\\/]*|[^\\/]*_test)\.py)$/.test(filename)) continue
      assert.ok(filename.split(path.sep).includes('__tests__'), filename)
    }
  }
})

test('package recipes resolve every explicitly referenced script and test collection from their original package cwd', () => {
  for (const owner of ['', 'apps/desktop']) {
    const directory = path.join(ROOT, owner)
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    for (const [name, command] of Object.entries(manifest.scripts)) {
      const references = command.match(/(?:\.\.?\/)*scripts\/[^\s"';&|]+\.(?:cjs|mjs|py|ps1|sh)/g) || []
      for (const reference of references) {
        assert.ok(fs.globSync(reference, { cwd: directory }).length > 0, `${owner || 'root'}:${name}: ${reference}`)
      }
    }
  }
})

test('both platform quality plans retain resolvable owned scripts in normal and quarantined recipes', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const quarantine of [false, true]) {
      for (const stage of planStages(platform, {}, { profile: 'offline', quarantine })) {
        for (const reference of stage.args || []) {
          if (!/^(?:\.\.?\/)*(?:scripts|apps\/desktop\/scripts)\/.+\.(?:cjs|mjs|py)$/.test(reference)) continue
          assert.ok(fs.globSync(reference, { cwd: stage.cwd }).length > 0, `${platform}:${stage.id}: ${reference}`)
        }
      }
    }
  }
})
