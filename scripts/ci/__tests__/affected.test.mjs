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

const SDK_TESTS = [
  'packages/ui/build.test.cjs',
  'packages/ui/render.test.cjs',
  'packages/ui/preview/browser.test.cjs',
]

function selectedNodeTests(result) {
  return result.commands.filter(item => item.command.startsWith('node ')).flatMap(item =>
    item.command.split(' ').filter(argument => /\.test\.(?:ts|tsx|mjs|cjs)$/.test(argument))
      .map(file => path.relative(ROOT, path.resolve(ROOT, item.cwd, file)).replaceAll(path.sep, '/')))
}

test('SDK shared sources retain the complete existing resource test closure', () => {
  for (const file of [
    'packages/ui/ui.css',
    'apps/desktop/src/renderer/src/components/primitive/utils.ts',
    'apps/desktop/src/renderer/src/components/primitive/Gallery.tsx',
    'apps/desktop/src/renderer/src/components/primitive/Images.tsx',
    'apps/desktop/src/renderer/src/features/literature/Matches.tsx',
    'apps/desktop/src/renderer/src/features/literature/export.ts',
  ]) {
    const result = plan([file])
    const selected = selectedNodeTests(result)
    for (const expected of SDK_TESTS) assert.ok(selected.includes(expected), `${file}: ${expected}`)
    assert.deepEqual(result.unmatched, [], file)
    assert.equal(result.fallback, null, file)
  }
})

test('SDK supplements remain additive when adjacent or consumer tests already match', () => {
  const result = plan([
    'apps/desktop/src/renderer/src/components/primitive/utils.ts',
    'apps/desktop/src/renderer/src/features/literature/export.ts',
  ])
  const selected = selectedNodeTests(result)
  for (const file of [
    ...SDK_TESTS,
    'apps/desktop/src/renderer/src/features/assistant/Outputs.render.test.ts',
    'apps/desktop/src/renderer/src/features/literature/export.test.ts',
  ]) assert.ok(selected.includes(file), file)
})

test('SDK test inputs deduplicate into one serial Node command and preserve unknown fallback', () => {
  const result = plan([...SDK_TESTS, ...SDK_TESTS, 'packages/ui/ui.css', 'README.md'])
  assert.deepEqual(selectedNodeTests(result).sort(), [...SDK_TESTS].sort())
  assert.equal(result.commands.length, 1)
  assert.match(result.commands[0].command, /--test-concurrency=1\b/)
  assert.deepEqual(result.unmatched, ['README.md'])
  assert.equal(result.fallback, 'pnpm ops ci test --profile quality')
  for (const file of SDK_TESTS) {
    const selection = plan([file])
    assert.deepEqual(selectedNodeTests(selection).sort(), [...SDK_TESTS].sort())
    assert.equal(selection.fallback, null)
  }
})

test('SDK routing normalizes Windows input paths without handing root paths to the Desktop cwd', () => {
  const files = ['packages/ui/ui.css', 'apps/desktop/src/renderer/src/features/literature/export.ts']
  const result = plan(files)
  assert.deepEqual(plan(files.map(file => file.replaceAll('/', '\\'))), result)
  assert.equal(result.commands[0].cwd, 'apps/desktop')
  assert.match(result.commands[0].command, /\.\.\/\.\.\/packages\/ui\/build\.test\.cjs/)
  assert.doesNotMatch(result.commands[0].command, /\\/)
})

for (const [file, consumers] of [
  ['apps/desktop/src/renderer/src/components/primitive/utils.ts', [
    'apps/desktop/src/renderer/src/components/markdown.render.test.ts',
  ]],
  ...['Gallery.tsx', 'Images.tsx'].map(name => [
    `apps/desktop/src/renderer/src/components/primitive/${name}`, [
      'apps/desktop/src/renderer/src/features/assistant/Images.render.test.ts',
      'apps/desktop/src/renderer/src/components/primitive/images.render.test.cjs',
    ],
  ]),
]) {
  test(`SDK supplements retain Desktop shared consumers for ${path.basename(file)}`, () => {
    const result = plan([file])
    const selected = selectedNodeTests(result)
    for (const expected of [...SDK_TESTS, ...consumers])
      assert.ok(selected.includes(expected), `${file}: ${expected}`)
    assert.equal(new Set(selected).size, selected.length)
    assert.equal(result.commands.length, 1)
    assert.match(result.commands[0].command, /--test-concurrency=1\b/)
    assert.deepEqual(result.unmatched, [])
    assert.equal(result.fallback, null)
  })
}
