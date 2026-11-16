import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_CATALOG } from './catalog.ts'
import { pdfeIterationPages } from './collaboration.ts'
import {
  PDFE_FEATURES,
  PDFE_ITERATION_DEFAULT,
  pdfeFeature,
  pdfeFeatureMatches,
  pdfeIterations,
  readIterationFilter,
  type PdfeFeature,
} from './iterations.ts'

test('the project browsing pilot has one unconfirmed introduction shared by its scenarios and alias', () => {
  assert.equal(PDFE_FEATURES.length, 1)
  const home = PREVIEW_CATALOG.find(page => page.id === 'page-home')!
  const feature = PDFE_FEATURES[0]
  assert.equal(feature.introducedIn, null)
  assert.deepEqual(feature.changes, [])
  for (const id of ['home-states', 'home-browse', 'home-empty', 'home-no-tasks', 'home-create']) {
    assert.equal(pdfeFeature(home.scenarios.find(scene => scene.id === id)!, home.scenarios), feature)
  }
  assert.equal(pdfeFeature(home.scenarios.find(scene => scene.id === 'home-cross-batch')!, home.scenarios), undefined)
})

test('unconfirmed filtering keeps only the pilot and never treats it as a new or updated release', () => {
  const before = JSON.stringify(PREVIEW_CATALOG)
  assert.equal(pdfeIterationPages(PREVIEW_CATALOG, PDFE_ITERATION_DEFAULT), PREVIEW_CATALOG)
  const pages = pdfeIterationPages(PREVIEW_CATALOG, { version: 'unconfirmed', scope: 'any' })
  assert.deepEqual(pages.map(page => page.id), ['page-home'])
  assert.deepEqual(pages[0].scenarios.filter(scene => !scene.aliasOf).map(scene => scene.id), ['home-states', 'home-empty', 'home-no-tasks'])
  assert.equal(pdfeFeatureMatches(PDFE_FEATURES[0], { version: 'unconfirmed', scope: 'added' }), false)
  assert.equal(pdfeFeatureMatches(undefined, { version: 'unconfirmed', scope: 'any' }), false)
  assert.equal(JSON.stringify(PREVIEW_CATALOG), before)
})

test('introduced and changed iterations are distinct and preserve earlier updates', () => {
  const feature: PdfeFeature = {
    id: 'project-browse',
    introducedIn: '0.3',
    changes: [
      { version: '0.3.1', summary: 'Synthetic update one' },
      { version: '0.3.1.1', summary: 'Synthetic update two' },
    ],
  }
  assert.equal(pdfeFeatureMatches(feature, { version: '0.3', scope: 'added' }), true)
  assert.equal(pdfeFeatureMatches(feature, { version: '0.3.1', scope: 'updated' }), true)
  assert.equal(pdfeFeatureMatches(feature, { version: '0.3.1.1', scope: 'added' }), false)
  assert.equal(pdfeFeatureMatches(feature, { version: '0.4', scope: 'any' }), false)
  assert.deepEqual(pdfeIterations([feature]), ['0.3.1.1', '0.3.1', '0.3'])
})

test('iteration ordering is numeric and never derives a release from the current package', () => {
  const features: PdfeFeature[] = [
    { id: 'project-browse', introducedIn: '0.3.9', changes: [{ version: '0.3.10', summary: 'Synthetic update' }] },
  ]
  assert.deepEqual(pdfeIterations(features), ['0.3.10', '0.3.9'])
  assert.deepEqual(pdfeIterations(), [])
})

test('filter restoration rejects malformed and stale selections and normalizes unconfirmed scope', () => {
  for (const value of [null, '{', 'null', '[]', '{"version":"9.9","scope":"any"}', '{"version":"all","scope":"bad"}']) {
    assert.deepEqual(readIterationFilter(value), PDFE_ITERATION_DEFAULT)
  }
  assert.deepEqual(readIterationFilter('{"version":"unconfirmed","scope":"updated"}'), { version: 'unconfirmed', scope: 'any' })
})

test('iteration metadata rejects malformed versions and updates earlier than introduction', () => {
  assert.throws(() => pdfeIterations([{ id: 'project-browse', introducedIn: 'latest', changes: [] }]), /Invalid PDFE iteration/)
  assert.throws(() => pdfeIterations([{ id: 'project-browse', introducedIn: '0.3.1', changes: [{ version: '0.3', summary: 'Synthetic invalid update' }] }]), /predates introduction/)
})

test('a matching nested feature retains its navigation parent without exposing unrelated scenarios', () => {
  const home = PREVIEW_CATALOG.find(page => page.id === 'page-home')!
  const child = PREVIEW_CATALOG.find(page => page.id === 'surface-project-form')!
  const pages = pdfeIterationPages([
    { ...home, scenarios: home.scenarios.map(scene => ({ ...scene, feature: undefined })) },
    { ...child, scenarios: child.scenarios.map(scene => ({ ...scene, feature: 'project-browse' as const })) },
  ], { version: 'unconfirmed', scope: 'any' })
  assert.deepEqual(pages.map(page => page.id), [home.id, child.id])
  assert.deepEqual(pages[0].scenarios, [])
  assert.equal(pages[1].scenarios.length, 1)
})
