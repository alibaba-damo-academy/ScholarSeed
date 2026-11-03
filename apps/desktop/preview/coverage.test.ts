import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_CATALOG } from './catalog.ts'
import { previewConsumption, previewCoverage } from './coverage.ts'

function report(annotations: { type: string; description: string }[], results: unknown[] = []) {
  return { suites: [{ suites: [{ specs: [{ file: 'surfaces.spec.ts', title: 'actual renderer consumption', tests: [{ projectName: 'preview', annotations, results }] }] }] }] }
}

test('coverage accounts for page-scene pairs, retaining duplicate scene identities across separate pages', () => {
  const entries = previewCoverage({ suites: [] })
  assert.equal(entries.length, PREVIEW_CATALOG.reduce((count, page) => count + page.scenarios.length, 0))
  assert.equal(entries.filter(entry => entry.sceneId === 'conversation-approval').length, 2)
  assert.equal(entries.find(entry => entry.pageId === 'viewer-web_search')!.status, 'unmapped')
  const page = PREVIEW_CATALOG.find(page => page.id === 'viewer-web_search')!
  const entry = entries.find(entry => entry.pageId === page.id)!
  assert.equal(entry.owner, page.owner)
  assert.equal(entry.source, page.source)
  assert.deepEqual(entry.expected, page.scenarios[0].expected)
  assert.deepEqual(entry.limitations, page.scenarios[0].limitations)
  for (const pageId of ['page-writing', 'settings-model-settings']) {
    const entry = entries.find(entry => entry.pageId === pageId)!
    assert.equal(entry.status, 'excluded')
    assert.ok(entry.reason)
  }
})

test('native-backed renderer controls remain uncovered instead of being excluded as native execution', () => {
  const entries = previewCoverage({ suites: [] })
  for (const pageId of ['page-browser', 'viewer-browser']) {
    const page = PREVIEW_CATALOG.find(page => page.id === pageId)!
    assert.equal(page.implementation, 'surface')
    const rows = entries.filter(entry => entry.pageId === pageId)
    assert.equal(rows.length, page.scenarios.length)
    for (const entry of rows) {
      assert.equal(entry.status, 'unmapped')
      assert.deepEqual(entry.missingStates, entry.states)
    }
    assert.equal(page.availability, 'hidden')
    assert.deepEqual(page.host, { kind: 'browser' })
  }
})

test('only declared consumer annotations count, and claimed states remain distinct from runtime pass evidence', () => {
  const partial = previewCoverage(report([previewConsumption('viewer-web_search', 'viewer-web_search-states', ['loaded'])]))
  const entry = partial.find(entry => entry.pageId === 'viewer-web_search')!
  assert.equal(entry.status, 'partial')
  assert.deepEqual(entry.coveredStates, ['loaded'])
  assert.deepEqual(entry.missingStates, ['loading', 'error'])
  assert.deepEqual(entry.consumers, [{ file: 'surfaces.spec.ts', title: 'actual renderer consumption', project: 'preview', states: ['loaded'] }])
  const annotation = previewConsumption('viewer-review', 'viewer-review-states', ['pending', 'accepted', 'rejected', 'revised'])
  const failed = previewCoverage(report([annotation], [{ status: 'failed' }]))
  const passed = previewCoverage(report([annotation], [{ status: 'passed' }]))
  assert.deepEqual(failed, passed)
  assert.equal(failed.find(entry => entry.sceneId === 'viewer-review-states')!.status, 'has-tests')
  assert.ok(failed.every(entry => !('passed' in entry)))
})

test('different real tests can cover separate states without broadening their individual assertions', () => {
  const states = ['pending', 'accepted', 'rejected', 'revised']
  const entries = previewCoverage({ suites: [{ specs: states.map(state => ({ file: 'surfaces.spec.ts', title: state, tests: [{ projectName: 'preview', annotations: [previewConsumption('viewer-review', 'viewer-review-states', [state])] }] })) }] })
  const entry = entries.find(entry => entry.sceneId === 'viewer-review-states')!
  assert.equal(entry.status, 'has-tests')
  assert.deepEqual(entry.coveredStates, states)
  assert.equal(entry.consumers.length, states.length)
})

test('invalid annotations and stale page, scene or state references fail rather than silently claiming coverage', () => {
  assert.throws(() => previewCoverage({ suites: [], errors: [{ message: 'Collection failed' }] }), /collection errors/)
  assert.throws(() => previewConsumption('unknown', 'unknown', ['loaded']), /Unknown preview/)
  assert.throws(() => previewConsumption('page-home', 'viewer-markdown-states', ['loaded']), /Unknown preview/)
  assert.throws(() => previewConsumption('viewer-markdown', 'viewer-markdown-states', ['imaginary']), /Unknown preview state/)
  assert.throws(() => previewConsumption('viewer-markdown', 'viewer-markdown-states', []), /states/)
  assert.throws(() => previewCoverage(report([{ type: 'preview-consumption', description: '{invalid' }])), /annotation/)
  assert.throws(() => previewCoverage(report([{ type: 'preview-consumption', description: JSON.stringify({ pageId: 'page-home', sceneId: 'home-states', states: ['imaginary'] }) }])), /Unknown preview state/)
  assert.deepEqual(previewCoverage(report([{ type: 'unrelated', description: 'not coverage' }])), previewCoverage({ suites: [] }))
})
