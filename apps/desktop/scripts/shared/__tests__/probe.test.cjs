const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {spawnSync} = require('node:child_process')
const {developmentPython} = require('../../../../../scripts/shared/python.cjs')
const {RUNTIME_PROBE_SCRIPT} = require('../probe.cjs')

const REPO = path.resolve(__dirname, '../../../../..')
const PYTHON = process.env.TEST_PYTHON || developmentPython(REPO, process.env.VENV, {context: process.env.CI ? 'ci' : 'local'})
const MODULES = ['scholarseed_runtime', 'damoatrace', 'service.cli.serve', 'service.cli.browser', 'scholarseed_codex', 'scholarseed_dsh', 'knowledge_layer.comprehend']

function probe(t, failure = false) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-probe-')))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  for (const name of MODULES) {
    const parts = name.split('.')
    for (let depth = 1; depth <= parts.length; depth++) {
      const folder = path.join(directory, ...parts.slice(0, depth))
      fs.mkdirSync(folder, {recursive: true})
      fs.writeFileSync(path.join(folder, '__init__.py'), '')
    }
  }
  fs.writeFileSync(path.join(directory, 'scholarseed_runtime', '__init__.py'),
    'print("Running in pure python mode (slow)")\n' + (failure ? 'raise RuntimeError("import failed")\n' : ''))
  const bootstrap = `import sys, sysconfig\nsys.path.insert(0, ${JSON.stringify(directory)})\nsysconfig.get_path = lambda *args, **kwargs: ${JSON.stringify(directory)}\n`
  return spawnSync(PYTHON, ['-I', '-B', '-c', bootstrap + RUNTIME_PROBE_SCRIPT], {
    encoding: 'utf8', timeout: 30000,
    env: {...process.env, SCHOLARSEED_PRODUCT_LIBS: ''}
  })
}

test('runtime probe keeps import diagnostics on stderr and stdout strictly JSON', t => {
  const result = probe(t)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(report.modules), [...MODULES].sort())
  assert.match(result.stderr, /Running in pure python mode \(slow\)/)
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
})

test('runtime probe preserves noisy import failures without emitting a success report', t => {
  const result = probe(t, true)
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Running in pure python mode \(slow\)/)
  assert.match(result.stderr, /RuntimeError: import failed/)
})
