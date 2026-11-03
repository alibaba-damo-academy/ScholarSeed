import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scenarioPath = fileURLToPath(new URL('./eval-scenarios/exploratory/research-evidence-revision/scenario.json', import.meta.url))
const scenarioDir = dirname(scenarioPath)
const exploratoryRoot = fileURLToPath(new URL('./eval-scenarios/exploratory/', import.meta.url))

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

test('research evidence revision source projection matches managed resource import layout', () => {
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as {
    id: string
    drive: string
    project: { files: { path: string; contentFrom: string }[] }
    expected: { minTurns: number; maxTurns: number }
  }
  const baseline = JSON.parse(readFileSync(join(scenarioDir, 'baseline.json'), 'utf8')) as {
    scenarioId: string
    provisional: boolean
  }
  assert.equal(scenario.id, 'research-evidence-revision')
  assert.equal(baseline.scenarioId, scenario.id)
  assert.equal(baseline.provisional, true)
  assert.deepEqual([scenario.expected.minTurns, scenario.expected.maxTurns], [2, 2])
  assert.deepEqual(
    readFileSync(join(scenarioDir, scenario.drive), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    [{ op: 'status' }]
  )

  const run = mkdtempSync(join(tmpdir(), 'scholarseed-eval-sources-'))
  const stagedSources = join(run, 'sources')
  const managedResources = join(run, 'project', 'resources')
  try {
    mkdirSync(stagedSources)
    mkdirSync(managedResources, { recursive: true })
    assert.deepEqual(
      scenario.project.files.map(file => file.path).sort(),
      ['resources/sources/study-a.md', 'resources/sources/study-b.md']
    )
    for (const file of scenario.project.files) {
      const source = resolve(scenarioDir, file.contentFrom)
      const target = resolve(stagedSources, basename(file.path))
      assert.equal(within(scenarioDir, source), true)
      assert.equal(within(stagedSources, target), true)
      assert.equal(existsSync(source), true)
      copyFileSync(source, target)
      assert.deepEqual(readFileSync(target), readFileSync(source))
    }
    assert.deepEqual(readdirSync(stagedSources).sort(), ['study-a.md', 'study-b.md'])
    cpSync(stagedSources, join(managedResources, 'sources'), { recursive: true })
    for (const file of scenario.project.files) {
      const imported = resolve(run, 'project', file.path)
      assert.equal(within(join(run, 'project'), imported), true)
      assert.deepEqual(readFileSync(imported), readFileSync(resolve(scenarioDir, file.contentFrom)))
    }
    assert.equal(existsSync(join(managedResources, 'sources', 'judge.md')), false)
    assert.equal(existsSync(join(managedResources, 'sources', 'driver.md')), false)
  } finally {
    rmSync(run, { recursive: true, force: true })
  }
})

test('default business directions consume valid and separate exploratory inputs', () => {
  for (const id of ['library-formats', 'literature-pdf-ai', 'conversation-flow', 'literature-ai-discovery']) {
    const root = join(exploratoryRoot, id)
    const scene = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8')) as {
      id: string
      drive: string
      project?: { files: { path: string; contentFrom: string }[] }
    }
    const baseline = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8')) as {
      scenarioId: string
      provisional: boolean
    }
    assert.equal(scene.id, id)
    assert.equal(baseline.scenarioId, id)
    assert.equal(baseline.provisional, true)
    assert.equal(scene.drive, 'cmd.jsonl')
    assert.deepEqual(
      readFileSync(join(root, scene.drive), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      [{ op: 'status' }]
    )
    assert.ok(readFileSync(join(root, 'driver.md'), 'utf8').length > 0)
    assert.ok(readFileSync(join(root, 'judge.md'), 'utf8').length > 0)
    for (const file of scene.project?.files ?? []) {
      const source = resolve(root, file.contentFrom)
      assert.equal(within(root, source), true)
      assert.equal(existsSync(source), true)
      assert.equal(file.path.startsWith('resources/'), true)
      assert.ok(readFileSync(source).length > 0)
    }
  }

  const literaturePdf = readFileSync(join(exploratoryRoot, 'literature-pdf-ai', 'fixtures', 'note-retrieval-pilot.pdf'))
  assert.equal(literaturePdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(literaturePdf.includes(Buffer.from('%%EOF')))
})
