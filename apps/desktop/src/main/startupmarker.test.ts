import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { isFirstRun, readStartupMarkerVersion, startupMarkerPath, writeStartupMarker } from './startupmarker.ts'

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
