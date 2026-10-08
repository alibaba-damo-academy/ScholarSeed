import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  isFirstRun,
  readStartupMarkerVersion,
  resolveStartupBudgetMs,
  STARTUP_BUDGET_ONE_TIME_MS,
  STARTUP_BUDGET_STEADY_MS,
  startupMarkerPath,
  writeStartupMarker,
} from './startupmarker.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'scholarseed-startup-'))
}

test('missing marker means first run', () => {
  const root = home()
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, '0.2.0'), true)
})

test('marker written after a successful start clears first run for that version only', () => {
  const root = home()
  writeStartupMarker(root, '0.2.0')
  assert.equal(readStartupMarkerVersion(root), '0.2.0')
  assert.equal(isFirstRun(root, '0.2.0'), false)
  assert.equal(isFirstRun(root, '0.2.1'), true)
})

test('marker write leaves no temporary residue', () => {
  const root = home()
  writeStartupMarker(root, '0.2.0')
  writeStartupMarker(root, '0.2.0')
  assert.deepEqual(readdirSync(root), ['startup-marker.json'])
})

test('corrupt or partial marker falls back to first run', () => {
  const root = home()
  writeFileSync(startupMarkerPath(root), '{ not json')
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, '0.2.0'), true)
  writeFileSync(startupMarkerPath(root), '{"schema":1}')
  assert.equal(readStartupMarkerVersion(root), null)
  assert.equal(isFirstRun(root, '0.2.0'), true)
})

test('启动预算：marker 只比 semver，冷组件展开由 per-launch 标志补一次性预算', () => {
  assert.equal(resolveStartupBudgetMs(false, false), STARTUP_BUDGET_STEADY_MS)
  assert.equal(resolveStartupBudgetMs(true, false), STARTUP_BUDGET_ONE_TIME_MS)
  assert.equal(resolveStartupBudgetMs(false, true), STARTUP_BUDGET_ONE_TIME_MS)
  assert.equal(resolveStartupBudgetMs(true, true), STARTUP_BUDGET_ONE_TIME_MS)
})
