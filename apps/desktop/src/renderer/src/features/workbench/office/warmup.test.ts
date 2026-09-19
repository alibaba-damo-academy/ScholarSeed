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

test('Office warmup defaults to a compact expandable status bar', () => {
  assert.match(warmupSource, /<Collapsible/)
  assert.match(warmupSource, /<CollapsibleTrigger/)
  assert.match(warmupSource, /<CollapsibleContent/)
  assert.match(warmupSource, /React\.useState\(false\)/)
  assert.match(warmupSource, /status\.stage === 'error' \|\| open/)
  assert.match(
    warmupSource,
    /w-\[calc\(var\(--vds-popover-width-md\)-var\(--vds-space-10\)\)\]/
  )
  assert.match(warmupSource, /aria-label=\{t\('officeWarmup\.title'\)\}/)
})

test('Office warmup keeps failure recovery visible without expanding details', () => {
  assert.match(warmupSource, /status\.stage === 'error'/)
  assert.match(warmupSource, /officeWarmup\.retry/)
})
