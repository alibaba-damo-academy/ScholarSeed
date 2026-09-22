import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  INITIAL_OFFICE_WARMUP_STATUS,
  OFFICE_WARMUP_RECOVERY_WINDOW_MS,
  OFFICE_WARMUP_SLOW_THRESHOLD_MS,
  isOfficeWarmupSlow,
  officeWarmupProgress,
  officeWarmupRetryDelay,
  parseOfficeWarmupStatus,
  shouldShowOfficeWarmup,
  shouldShowOfficeWarmupProgress,
  type OfficeWarmupStatus
} from './progress.ts'

const warmupSource = readFileSync(
  new URL('./Warmup.tsx', import.meta.url),
  'utf8'
)
const runtimeSource = readFileSync(
  new URL('./runtime.tsx', import.meta.url),
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
  assert.equal(shouldShowOfficeWarmup(INITIAL_OFFICE_WARMUP_STATUS, false), false)
  assert.equal(shouldShowOfficeWarmupProgress(INITIAL_OFFICE_WARMUP_STATUS, false), false)
})

test('Office warmup keeps failure recovery visible', () => {
  const failed: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'runtime-assets'
  }
  assert.equal(shouldShowOfficeWarmup(failed, false), true)
  assert.equal(shouldShowOfficeWarmupProgress(failed, false), false)
  assert.match(warmupSource, /className=\{`pointer-events-auto /)
  assert.match(
    warmupSource,
    /status\.stage === 'error'\s*\? 'z-\[var\(--vds-z-toast\)\]'\s*: 'z-\[var\(--vds-z-background-task\)\]'/
  )
  assert.match(warmupSource, /status\.stage === 'error'\s*\? createPortal\(content, document\.body\)\s*: content/)
  assert.match(warmupSource, /data-testid="office-font-warmup"/)
  assert.match(warmupSource, /officeWarmup\.error/)
  assert.match(warmupSource, /officeWarmup\.retry/)
  assert.match(warmupSource, /const \[dismissedError, setDismissedError\] = useState\(false\)/)
  assert.match(warmupSource, /if \(status\.stage !== 'error' && dismissedError\) setDismissedError\(false\)/)
  assert.match(warmupSource, /status\.stage === 'error' && dismissedError/)
  assert.match(warmupSource, /<CardHeader className="pb-\[var\(--vds-space-2\)\]">\s*<div className="flex items-center justify-between gap-\[var\(--vds-space-2\)\]">/)
  assert.match(warmupSource, /<IconButton[\s\S]*label=\{t\('officeDocument\.close'\)\}/)
})

test('retry rebuilds the WASM frame and enables progress', () => {
  assert.equal(shouldShowOfficeWarmup(INITIAL_OFFICE_WARMUP_STATUS, true), true)
  assert.equal(shouldShowOfficeWarmupProgress(INITIAL_OFFICE_WARMUP_STATUS, true), true)
  assert.match(runtimeSource, /setFrameEpoch\(epoch => epoch \+ 1\)/)
  assert.match(runtimeSource, /setShowWarmupProgress\(true\)/)
})

test('warmup distinguishes failure causes from diagnostic detail', () => {
  assert.deepEqual(parseOfficeWarmupStatus({
    stage: 'error',
    error: 'font-permission',
    detail: 'NotAllowedError: Permission denied'
  }), {
    stage: 'error',
    done: 0,
    total: 0,
    loadedBytes: 0,
    error: 'font-permission',
    detail: 'NotAllowedError: Permission denied'
  })
  assert.equal(
    parseOfficeWarmupStatus({ stage: 'error', error: 'vendor-private-error' })?.error,
    'runtime-execution'
  )
})

test('only runtime failures retry inside the bounded recovery window', () => {
  const runtimeFailure: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'runtime-assets'
  }
  const fontFailure: OfficeWarmupStatus = {
    ...INITIAL_OFFICE_WARMUP_STATUS,
    stage: 'error',
    error: 'font-permission'
  }

  assert.equal(officeWarmupRetryDelay(runtimeFailure, 0, 0), 1_000)
  assert.equal(officeWarmupRetryDelay(runtimeFailure, 10_000, 2), 10_000)
  assert.equal(officeWarmupRetryDelay(fontFailure, 0, 0), null)
  assert.equal(
    officeWarmupRetryDelay(runtimeFailure, OFFICE_WARMUP_RECOVERY_WINDOW_MS - 500, 0),
    null
  )
})

test('slow guidance starts after one minute without converting progress into failure', () => {
  const runtime: OfficeWarmupStatus = { ...INITIAL_OFFICE_WARMUP_STATUS, stage: 'runtime' }

  assert.equal(isOfficeWarmupSlow(runtime, OFFICE_WARMUP_SLOW_THRESHOLD_MS - 1), false)
  assert.equal(isOfficeWarmupSlow(runtime, OFFICE_WARMUP_SLOW_THRESHOLD_MS), true)
  assert.equal(isOfficeWarmupSlow({ ...runtime, stage: 'ready' }, OFFICE_WARMUP_SLOW_THRESHOLD_MS), false)
  assert.equal(isOfficeWarmupSlow({ ...runtime, stage: 'error' }, OFFICE_WARMUP_SLOW_THRESHOLD_MS), false)
})

test('dismissal hides progress without sending cancellation to the Office frame', () => {
  assert.match(warmupSource, /onDismiss: \(\) => void/)
  assert.match(warmupSource, /status\.stage === 'error' && !recovering \? setDismissedError\(true\) : onDismiss\(\)/)
  assert.match(runtimeSource, /const dismissWarmup = useCallback/)
  assert.match(runtimeSource, /onDismiss=\{dismissWarmup\}/)
  assert.doesNotMatch(runtimeSource, /onDismiss=.*post\('dispose'\)/)
  assert.doesNotMatch(runtimeSource, /onDismiss=.*setFrame\(null\)/)
})
