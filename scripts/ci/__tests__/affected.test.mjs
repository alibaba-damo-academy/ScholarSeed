import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { adjacentTest, suiteForSource, plan } = require('../affected.cjs')
const { planStages } = require('../test.cjs')
const ROOT = path.resolve(import.meta.dirname, '../../..')
const CLI = path.join(ROOT, 'scripts/ci/affected.cjs')

function invoke(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
}

test('normal CI registers the affected CLI regression suite on both platforms', () => {
  for (const platform of ['darwin', 'win32']) {
    const stage = planStages(platform, {}, { profile: 'offline', quarantine: true })
      .find(item => item.id === 'desktop-extra-node')
    assert.ok(stage.args.includes('scripts/ci/__tests__/affected.test.mjs'))
  }
})

test('CLI only treats explicit user paths as targets', () => {
  const result = invoke(['--json', 'README.md'])
  assert.equal(result.status, 3, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.targets, ['README.md'])
  assert.deepEqual(report.unmatched, ['README.md'])
})

test('CLI returns the adjacent fast test without a spurious full-CI fallback', () => {
  const result = invoke(['--json', 'apps/desktop/src/main/handoff.ts'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.targets, ['apps/desktop/src/main/handoff.ts'])
  assert.deepEqual(report.unmatched, [])
  assert.equal(report.fallback, null)
  assert.ok(report.commands.some(item => item.cwd === 'apps/desktop' &&
    item.command.includes('src/main/handoff.test.ts')))
})

test('CLI reads dirty changes without treating HEAD or its own script as files', () => {
  const diff = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR'],
    { cwd: ROOT, encoding: 'utf8' })
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(diff.status, 0, diff.stderr)
  assert.equal(untracked.status, 0, untracked.stderr)
  const expected = [...new Set([diff.stdout, untracked.stdout].flatMap(output =>
    output.split('\n').filter(Boolean)))].sort()
  for (const args of [['--json'], ['--json', '--base', 'HEAD']]) {
    const result = invoke(args)
    assert.ok([0, 3].includes(result.status), result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).targets.sort(), expected)
  }
})

test('CLI rejects incomplete and unknown options instead of guessing paths', () => {
  for (const args of [['--base'], ['--base', '--json'], ['--unknown']]) {
    const result = invoke(args)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /requires a ref|unknown option/)
    assert.equal(result.stdout, '')
  }
})

test('adjacentTest resolves sibling tests against the repository root', () => {
  assert.equal(adjacentTest('apps/desktop/src/main/handoff.ts'), 'apps/desktop/src/main/handoff.test.ts')
  assert.equal(adjacentTest('apps/desktop/src/main/no-such-module-xyz.ts'), null)
})

test('suiteForSource matches bare and dotted suite names by stem', () => {
  const suites = ['contract_alpha', 'tests.release.contract_lint']
  assert.equal(suiteForSource('apps/serve/service/contract_alpha.py', suites), 'contract_alpha')
  assert.equal(suiteForSource('tests/release/contract_lint.py', suites), 'tests.release.contract_lint')
  assert.equal(suiteForSource('apps/serve/service/unrelated.py', suites), null)
})

test('plan falls back to L2 when nothing maps', () => {
  const result = plan(['README.md', 'docs/notes.md'])
  assert.deepEqual(result.commands, [])
  assert.equal(result.unmatched.length, 2)
  assert.equal(result.fallback, 'pnpm ops ci test --profile quality')
})
