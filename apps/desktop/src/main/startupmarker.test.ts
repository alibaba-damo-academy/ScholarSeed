import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  decodeStartupMarkerVersion,
  isFirstRun,
  readStartupMarkerVersion,
  resolveStartupBudgetMs,
  STARTUP_BUDGET_ONE_TIME_MS,
  STARTUP_BUDGET_STEADY_MS,
  STARTUP_MARKER_MAX_BYTES,
  startupMarkerPath,
  writeStartupMarker,
} from './startupmarker.ts'

const release = { version: '0.2.0', buildNumber: '202610080900' }
const nextBuild = { version: '0.2.0', buildNumber: '202610081000' }
const nextVersion = { version: '0.2.1', buildNumber: '202610081000' }

test('startup marker codec preserves full build identity and rejects unknown schemas', () => {
  assert.equal(
    decodeStartupMarkerVersion(Buffer.from('{"schema":1,"appVersion":"0.2.0-202610080900"}')),
    '0.2.0-202610080900'
  )
  for (const value of [
    null,
    [],
    { schema: 2, appVersion: '0.2.0' },
    { schema: true, appVersion: '0.2.0' },
    { schema: 1, appVersion: 2 },
  ])
    assert.equal(decodeStartupMarkerVersion(Buffer.from(JSON.stringify(value))), null)
  assert.throws(() => decodeStartupMarkerVersion(Buffer.from([255])))
  assert.throws(() => decodeStartupMarkerVersion(Buffer.alloc(STARTUP_MARKER_MAX_BYTES + 1)))
})

function home(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'scholarseed-startup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('missing marker means first run', (t) => {
  const root = home(t)
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, release), true)
})

test('marker written after a successful start clears first run for that version only', (t) => {
  const root = home(t)
  writeStartupMarker(root, release)
  assert.equal(readStartupMarkerVersion(root), '0.2.0-202610080900')
  assert.equal(isFirstRun(root, release), false)
  assert.equal(isFirstRun(root, nextVersion), true)
})

test('marker write leaves no temporary residue', (t) => {
  const root = home(t)
  writeStartupMarker(root, release)
  writeStartupMarker(root, release)
  assert.deepEqual(readdirSync(root), ['startup-marker.json'])
})

test('corrupt or partial marker falls back to first run', (t) => {
  const root = home(t)
  writeFileSync(startupMarkerPath(root), '{ not json')
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, release), true)
  writeFileSync(startupMarkerPath(root), '{"schema":1}')
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, release), true)
  writeFileSync(startupMarkerPath(root), Buffer.alloc(STARTUP_MARKER_MAX_BYTES + 1))
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, release), true)
})

test('cold component preparation retains the one-time startup budget', () => {
  assert.equal(resolveStartupBudgetMs(false, false), STARTUP_BUDGET_STEADY_MS)
  assert.equal(resolveStartupBudgetMs(true, false), STARTUP_BUDGET_ONE_TIME_MS)
  assert.equal(resolveStartupBudgetMs(false, true), STARTUP_BUDGET_ONE_TIME_MS)
  assert.equal(resolveStartupBudgetMs(true, true), STARTUP_BUDGET_ONE_TIME_MS)
})

test('preparation budget preserves readiness time for an existing build and first-run floors', () => {
  assert.equal(resolveStartupBudgetMs(false, false, 90_000), 135_000)
  assert.equal(resolveStartupBudgetMs(true, false, 90_000), STARTUP_BUDGET_ONE_TIME_MS)
  assert.equal(resolveStartupBudgetMs(false, true, 90_000), STARTUP_BUDGET_ONE_TIME_MS)
})

test('same version with a newer build receives its own first-start budget', (t) => {
  const root = home(t)
  writeStartupMarker(root, release)
  assert.equal(isFirstRun(root, nextBuild), true)
  assert.equal(
    resolveStartupBudgetMs(isFirstRun(root, nextBuild), false),
    STARTUP_BUDGET_ONE_TIME_MS
  )
  writeStartupMarker(root, nextBuild)
  assert.equal(isFirstRun(root, nextBuild), false)
  assert.equal(isFirstRun(root, release), true)
})

test('old semver-only markers cannot make a packaged build warm', (t) => {
  const root = home(t)
  writeFileSync(startupMarkerPath(root), JSON.stringify({ schema: 1, appVersion: '0.2.0' }))
  assert.equal(isFirstRun(root, release), true)
  writeStartupMarker(root, release)
  assert.equal(isFirstRun(root, release), false)
})

test('failed publication closes and removes its own temporary marker', (t) => {
  const root = home(t)
  mkdirSync(startupMarkerPath(root))
  assert.throws(() => writeStartupMarker(root, release))
  assert.deepEqual(readdirSync(root), ['startup-marker.json'])
})

test('unsupported marker schema cannot shorten the startup budget', (t) => {
  const root = home(t)
  writeFileSync(
    startupMarkerPath(root),
    JSON.stringify({ schema: 999, appVersion: '0.2.0-202610080900' })
  )
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, release), true)
})
