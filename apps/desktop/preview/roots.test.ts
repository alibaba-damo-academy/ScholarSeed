import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewRoots } from './roots.ts'

test('virtual authorization derives exact allowed roots from live ledgers and never expands ancestors or child paths', () => {
  let projects = ['/preview/workspace', '/preview/workspace/project']
  const roots = new PreviewRoots({ workspace: () => projects, session: () => ['/preview/session/one'], external: () => [] })
  assert.equal(roots.update({ scope: 'workspace', roots: projects, mode: 'replace' }), true)
  assert.deepEqual(roots.counts(), { workspace: 2, session: 0, external: 0 })
  for (const value of [null, { scope: '__proto__', roots: [], mode: 'replace' }, { scope: 'external', roots: ['/preview/workspace'], mode: 'add' }, { scope: 'workspace', roots: ['/preview/workspace/project/child'], mode: 'replace' }, { scope: 'workspace', roots: ['/Users/private'], mode: 'add' }, { scope: 'workspace', roots: ['/preview/workspace/../private'], mode: 'replace' }, { scope: 'workspace', roots: [null], mode: 'replace' }]) {
    assert.equal(roots.update(value), false)
    assert.deepEqual(roots.read('workspace'), projects)
  }
  projects = ['/preview/workspace']
  assert.deepEqual(roots.read('workspace'), projects)
  assert.equal(roots.update({ scope: 'workspace', roots: [], mode: 'replace' }), true)
  assert.deepEqual(roots.read('workspace'), [])
  assert.equal(roots.update({ scope: 'session', roots: ['/preview/session/one'], mode: 'add' }), true)
  assert.equal(roots.update({ scope: 'session', roots: ['/preview/session/one'], mode: 'add' }), true)
  assert.deepEqual(roots.counts(), { workspace: 0, session: 1, external: 0 })
  roots.dispose()
  assert.equal(roots.update({ scope: 'session', roots: [], mode: 'replace' }), false)
  assert.deepEqual(roots.counts(), { workspace: 0, session: 0, external: 0 })
})
