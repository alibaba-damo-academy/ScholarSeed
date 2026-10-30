const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { runStage } = require('../test.cjs')
const { validateCollection, validateCaseReport, validateNodeReport, plannedStages } = require('../smoke.cjs')
const manifest = require('../smoke.json')
const ROOT = path.resolve(__dirname, '../../..')

for (const missingReport of [false, true]) {
test(`Python runner ${missingReport ? 'missing report' : 'tracebacks'} survives runStage and the inherited console boundary`, t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-diagnostics-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const pkg = path.join(directory, 'diagnostic_probe')
  fs.mkdirSync(pkg)
  fs.writeFileSync(path.join(pkg, '__init__.py'), '')
  fs.writeFileSync(path.join(pkg, 'entry.py'),
    missingReport ? "import os, unittest\nclass Probe(unittest.TestCase):\n def test_pass(self): pass\ntry: unittest.main()\nfinally: os._exit(0)\n" :
    "import unittest\nclass Probe(unittest.TestCase):\n" +
    " def test_first(self): raise RuntimeError('first diagnostic failure')\n" +
    " def test_last(self): self.fail('last diagnostic failure ' + 'x' * 5000)\n" +
    "if __name__ == '__main__': unittest.main()\n")
  const stage = { id: 'python-run-all', kind: 'python', progress: true,
    cwd: path.join(ROOT, 'apps/serve'), reportArg: true, reportKind: 'runall',
    env: { PYTHONPATH: [directory, path.join(ROOT, 'apps/serve'), ROOT].join(path.delimiter),
      PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    args: ['-c', "import sys; from tests import run_all; run_all.SUITES=['entry']; run_all.SLOW=[]; run_all.SERVE_SUITE_PREFIX='diagnostic_probe.'; sys.exit(run_all.main())",
      '--jobs', '1', '--case-report-dir', path.join(directory, 'cases')] }
  const source = `const {runStage}=require(${JSON.stringify(path.join(ROOT, 'scripts/ci/test.cjs'))});
    const result=runStage(${JSON.stringify(stage)},${JSON.stringify(directory)},process.platform,'a'.repeat(40));
    process.exitCode=result.exitCode;`
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /\[ci:failure\].*python-run-all/)
  if (missingReport) {
    assert.match(result.stderr, /suite=entry exit=0/)
    assert.match(result.stderr, /\[Errno 2\]/)
  } else {
  assert.match(result.stderr, /Traceback \(most recent call last\)/)
  assert.match(result.stderr, /RuntimeError: first diagnostic failure/)
  assert.match(result.stderr, /AssertionError: last diagnostic failure/)
  }
  const raw = fs.readFileSync(path.join(directory, 'python-run-all.stderr.log'), 'utf8')
  assert.ok(result.stderr.includes(raw), 'entire raw Python stderr reaches outer console')
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'python-run-all.json'))).verdict, 'fail')
})
}

test('real runner collection matches the smoke manifest', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-collection-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const python = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const entry = structuredClone(manifest.entries.find(item => item.id === 'runner-lifecycle'))
  const collectionPath = path.join(directory, 'collection.json')
  const collection = spawnSync(python, ['-P', '-m', 'tests.observations', '--module', 'tests.contract_runner',
    '--collect-only', '--report', collectionPath, '--isolation-root', directory], {
    cwd: path.join(ROOT, 'apps/serve'), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONPATH: [path.join(ROOT, 'apps/serve'), ROOT].join(path.delimiter) } })
  assert.equal(collection.status, 0, collection.stderr)
  entry.expectedCases = validateCollection(JSON.parse(fs.readFileSync(collectionPath)), entry)
  const report = path.join(directory, 'runner.json')
  const result = spawnSync(python, ['-c', "import sys; from tests import run_all; run_all.SUITES=['contract_runner']; run_all.SLOW=[]; sys.exit(run_all.main())",
    '--jobs', '1', '--case-report-dir', path.join(directory, 'cases'), '--report', report], {
    cwd: path.join(ROOT, 'apps/serve'), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONIOENCODING: 'utf-8' } })
  assert.equal(result.status, 0, result.stderr)
  const raw = JSON.parse(fs.readFileSync(report))
  assert.equal(validateCaseReport(raw.results[0].observations, entry).length, entry.expectedCases.length)
})


test('real Node smoke collections match the manifest', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-node-collection-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const entry of manifest.entries.filter(item => item.runner.kind === 'node')) {
    const stage = plannedStages(manifest, { suites: [] }, process.platform, directory)
      .find(item => item.id === entry.id)
    const result = runStage(stage, directory, process.platform, 'a'.repeat(40))
    assert.equal(result.exitCode, 0, fs.readFileSync(path.join(directory, `${entry.id}.stderr.log`), 'utf8'))
    const raw = JSON.parse(fs.readFileSync(result.report))
    assert.equal(validateNodeReport(raw, entry).length, entry.expectedCount)
  }
})
