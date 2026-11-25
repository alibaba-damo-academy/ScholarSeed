import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setupPreviewCache as setup } from './previewcache.fixture.ts'
import { stagedInstallerName } from './staging.ts'

test('preview cancellation removes partial payload without ready state and preserves unrelated files', (t) => {
  const h = setup(t)
  h.discard()
  assert.equal(existsSync(h.partial), false)
  assert.equal(existsSync(join(h.state, 'preparation.json')), false)
  assert.equal(readFileSync(join(h.cache, 'user-notes.txt'), 'utf8'), 'keep')
  assert.equal(existsSync(join(h.cache, 'install-owned.sh')), true)
})

test('release cleanup is unchanged and committed handoff cannot be revoked', (t) => {
  const release = setup(t, false)
  release.discard()
  assert.equal(existsSync(release.partial), true)
  assert.equal(existsSync(join(release.state, 'preparation.json')), true)
  assert.equal(release.cleared(), 0)
  const committed = setup(t, true, true)
  assert.throws(committed.discard, /handoff/)
  assert.equal(existsSync(committed.partial), true)
})

test('preview payload cleanup preserves the existing active-mount protection', (t) => {
  const h = setup(t)
  mkdirSync(join(h.cache, 'mount-active'))
  writeFileSync(join(h.cache, 'mount-active', 'in-use'), 'keep')
  h.discard()
  assert.equal(existsSync(h.partial), true)
})

test('preview paths cannot clear same-version release payloads, records or recovery journals', (t) => {
  const h = setup(t)
  const releaseCache = join(h.root, 'cache', 'scholarseed-update')
  const releaseState = join(h.root, 'state')
  const shared = [
    join(releaseCache, stagedInstallerName('0.3.0', '202610200001', 'darwin')),
    join(releaseState, 'ready.json'),
    join(releaseState, 'preparation.json'),
    join(releaseState, 'squirrel.json'),
  ]
  for (const path of shared) writeFileSync(path, 'release-or-legacy')
  assert.equal(h.cache, join(h.cacheRoot, 'preview'))
  assert.ok(h.state.startsWith(join(releaseState, 'profiles')))
  assert.equal(h.ready, join(h.state, 'ready.json'))
  h.discard()
  for (const path of shared) assert.equal(readFileSync(path, 'utf8'), 'release-or-legacy')
  const release = setup(t, false)
  assert.equal(release.cache, release.cacheRoot)
  assert.ok(release.state.startsWith(join(release.root, 'state', 'profiles')))
  assert.equal(release.ready, join(release.state, 'ready.json'))
})

test('inactive lane pruning removes only stale artifacts owned by the same profile', async (t) => {
  const active = setup(t, true)
  const other = setup(t, false, false, 'other-profile', active.root)
  assert.notEqual(other.state, active.state)
  const payload = join(active.cacheRoot, 'scholarseed-0.3.0-202610200001.dmg')
  const prepared = payload + '.prepared'
  writeFileSync(payload, 'stale download')
  mkdirSync(prepared)
  for (const path of [payload, prepared, other.partial]) utimesSync(path, 0, 0)
  const mount = join(active.cacheRoot, 'mount-active')
  mkdirSync(mount)
  const owned = join(mount, 'mounted')
  writeFileSync(owned, 'mounted')
  await active.pruneInactive()
  assert.equal(existsSync(payload), true)
  rmSync(owned)
  await active.pruneInactive()
  assert.equal(existsSync(payload), false)
  assert.equal(existsSync(prepared), false)
  assert.equal(existsSync(other.partial), true)
  assert.equal(existsSync(active.partial), true)
})
