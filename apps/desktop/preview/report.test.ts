import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PREVIEW_CATALOG } from './catalog.ts'
import { previewConsumption } from './coverage.ts'

const REPORT_SCRIPT = fileURLToPath(new URL('./report.ts', import.meta.url))

function run(input: string, args: string[] = ['-']) {
  return spawnSync(process.execPath, ['--experimental-transform-types', REPORT_SCRIPT, ...args], { input, encoding: 'utf8' })
}

test('coverage command consumes a real Playwright report shape and retains Owner, expectations and explicit gaps', () => {
  const annotation = previewConsumption('viewer-web_search', 'viewer-web_search-states', ['loaded'])
  const source = { errors: [], suites: [{ specs: [{ file: 'surfaces.spec.ts', title: 'Real search UI', tests: [{ projectName: 'preview', annotations: [annotation], results: [{ status: 'failed' }] }] }] }] }
  const result = run(JSON.stringify(source))
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.scope, 'Declared test associations only; not execution results or product acceptance')
  assert.equal(report.total, PREVIEW_CATALOG.reduce((count, page) => count + page.scenarios.length, 0))
  assert.equal(Object.values(report.summary).reduce((count: number, value) => count + Number(value), 0), report.total)
  const entry = report.entries.find((entry: { pageId: string }) => entry.pageId === 'viewer-web_search')
  assert.equal(entry.status, 'partial')
  assert.deepEqual(entry.missingStates, ['loading', 'error'])
  assert.ok(entry.owner && entry.source && entry.expected.length && entry.limitations.length)
  assert.equal(entry.consumers[0].title, 'Real search UI')
  assert.equal('passed' in report, false)
  assert.equal('execution' in report, false)
  assert.equal('results' in entry.consumers[0], false)
})

test('malformed JSON, collection failures and invalid arguments fail without a misleading coverage report', () => {
  for (const input of ['not JSON', '{}', JSON.stringify({ suites: [], errors: [{ message: 'fixture failed to import' }] })]) {
    const result = run(input)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes('Preview coverage report failed'))
  }
  const extra = run('{}', ['-', 'unexpected'])
  assert.notEqual(extra.status, 0)
  assert.equal(extra.stdout, '')
  assert.ok(extra.stderr.includes('Usage:'))
  const help = run('', ['--help'])
  assert.equal(help.status, 0)
  assert.ok(help.stdout.includes('Usage:'))
})

test('coverage command reads explicit file paths including spaces without shell interpretation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'preview coverage '))
  try {
    const path = join(directory, 'playwright list.json')
    writeFileSync(path, JSON.stringify({ errors: [], suites: [] }))
    const result = run('', [path])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.entries.length, report.total)
    assert.ok(report.summary.unmapped > 0)
    const missing = run('', [join(directory, 'missing.json')])
    assert.notEqual(missing.status, 0)
    assert.equal(missing.stdout, '')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
