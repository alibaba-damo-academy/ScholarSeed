import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  officeWarmupProgress,
  type OfficeWarmupStatus
} from './progress.ts'

const warmupSource = readFileSync(
  new URL('./Warmup.tsx', import.meta.url),
  'utf8'
)

test('font reading progress accounts for every catalog entry', () => {
  const status: OfficeWarmupStatus = {
    stage: 'reading',
    done: 37,
    total: 100,
    loadedBytes: 4_096
  }
  assert.equal(officeWarmupProgress(status), 37)
})

test('runtime readiness completes the progress bar', () => {
  assert.equal(
    officeWarmupProgress({
      stage: 'ready',
      done: 0,
      total: 0,
      loadedBytes: 0
    }),
    100
  )
})

test('catalog and runtime initialization remain indeterminate', () => {
  assert.equal(
    officeWarmupProgress({
      stage: 'catalog',
      done: 0,
      total: 0,
      loadedBytes: 0
    }),
    null
  )
  assert.equal(
    officeWarmupProgress({
      stage: 'runtime',
      done: 0,
      total: 0,
      loadedBytes: 0
    }),
    null
  )
})

test('Office warmup stays hidden during normal initialization', () => {
  assert.match(warmupSource, /if \(status\.stage !== 'error'\) return null/)
  assert.doesNotMatch(warmupSource, /<Collapsible/)
  assert.doesNotMatch(warmupSource, /<ProgressBar/)
  assert.doesNotMatch(warmupSource, /<Spinner/)
})

test('Office warmup keeps failure recovery visible', () => {
  assert.match(warmupSource, /data-testid="office-font-warmup"/)
  assert.match(warmupSource, /officeWarmup\.error/)
  assert.match(warmupSource, /officeWarmup\.retry/)
})
