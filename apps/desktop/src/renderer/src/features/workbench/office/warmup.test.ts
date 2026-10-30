import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import './local-fonts.test.cjs'

import {
  INITIAL_OFFICE_WARMUP_STATUS,
  OFFICE_WARMUP_MAX_RETRIES,
  OFFICE_WARMUP_RECOVERY_WINDOW_MS,
  OFFICE_WARMUP_RETRY_DELAYS_MS,
  OFFICE_WARMUP_SLOW_THRESHOLD_MS,
  isOfficeWarmupSlow,
  officeWarmupProgress,
  officeWarmupRetryDelay,
  parseOfficeWarmupStatus,
  type OfficeWarmupStatus,
} from './progress.ts'

const runtimeSource = readFileSync(new URL('./runtime.tsx', import.meta.url), 'utf8')

test('font reading progress accounts for every catalog entry', () => {
  const status: OfficeWarmupStatus = {
    stage: 'reading',
    done: 37,
    total: 100,
    loadedBytes: 4_096,
  }
  assert.equal(officeWarmupProgress(status), 37)
})

test('runtime readiness completes the progress bar', () => {
  assert.equal(
    officeWarmupProgress({
      stage: 'ready',
      done: 0,
      total: 0,
      loadedBytes: 0,
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
      loadedBytes: 0,
    }),
    null
  )
  assert.equal(
    officeWarmupProgress({
      stage: 'runtime',
      done: 0,
      total: 0,
      loadedBytes: 0,
    }),
    null
  )
})

test('Office recovery feedback is mounted in the document anchor, not a notification', () => {
  assert.doesNotMatch(runtimeSource, /import.*OfficeWarmup|<OfficeWarmup\b/)
  assert.match(runtimeSource, /visible && bounds && hasDocument && !documentReady/)
  assert.match(runtimeSource, /<OfficeLoading\s+recovery=\{recovery\}/)
})

test('automatic retry rebuilds the WASM frame and retains failure diagnostics', () => {
  assert.match(runtimeSource, /setFrameEpoch\((?:epoch|\(epoch\)) => epoch \+ 1\)/)
  assert.match(runtimeSource, /updateRecovery\(\{ type: 'retry' \}\)/)
  assert.match(runtimeSource, /OFFICE_WARMUP_RECOVERY_WINDOW_MS/)
  assert.match(runtimeSource, /stage: 'warmup-timeout'/)
  assert.match(runtimeSource, /stage: 'warmup-failed'/)
  assert.match(runtimeSource, /failure: status\.error/)
  assert.match(runtimeSource, /detail: status\.detail/)
})

test('warmup distinguishes failure causes from diagnostic detail', () => {
  assert.deepEqual(
    parseOfficeWarmupStatus({
      stage: 'error',
      error: 'font-permission',
      detail: 'NotAllowedError: Permission denied',
    }),
    {
      stage: 'error',
      done: 0,
      total: 0,
      loadedBytes: 0,
      error: 'font-permission',
      detail: 'NotAllowedError: Permission denied',
    }
  )
  assert.equal(
    parseOfficeWarmupStatus({ stage: 'error', error: 'vendor-private-error' })?.error,
    'runtime-execution'
  )
  assert.equal(
    parseOfficeWarmupStatus({ stage: 'error', error: 'warmup-timeout' })?.error,
    'warmup-timeout'
  )
})

test('recoverable warmup failures retry silently three times with patient backoff', () => {
  const runtimeFailure: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'runtime-assets',
  }
  const catalogFailure: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'font-catalog',
  }
  const fontReadFailure: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'font-read',
  }
  const permissionFailure: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'font-permission',
  }

  assert.deepEqual(OFFICE_WARMUP_RETRY_DELAYS_MS, [15_000, 45_000, 120_000])
  assert.equal(OFFICE_WARMUP_MAX_RETRIES, 3)
  assert.equal(OFFICE_WARMUP_RECOVERY_WINDOW_MS, 600_000)
  assert.equal(officeWarmupRetryDelay(runtimeFailure, 0), 15_000)
  assert.equal(officeWarmupRetryDelay(catalogFailure, 1), 45_000)
  assert.equal(officeWarmupRetryDelay(fontReadFailure, 2), 120_000)
  assert.equal(officeWarmupRetryDelay(runtimeFailure, OFFICE_WARMUP_MAX_RETRIES), null)
  assert.equal(officeWarmupRetryDelay(permissionFailure, 0), null)
})

test('slow guidance starts after one minute without converting progress into failure', () => {
  const runtime: OfficeWarmupStatus = { ...INITIAL_OFFICE_WARMUP_STATUS, stage: 'runtime' }

  assert.equal(isOfficeWarmupSlow(runtime, OFFICE_WARMUP_SLOW_THRESHOLD_MS - 1), false)
  assert.equal(isOfficeWarmupSlow(runtime, OFFICE_WARMUP_SLOW_THRESHOLD_MS), true)
  assert.equal(
    isOfficeWarmupSlow({ ...runtime, stage: 'ready' }, OFFICE_WARMUP_SLOW_THRESHOLD_MS),
    false
  )
  assert.equal(
    isOfficeWarmupSlow({ ...runtime, stage: 'error' }, OFFICE_WARMUP_SLOW_THRESHOLD_MS),
    false
  )
})
