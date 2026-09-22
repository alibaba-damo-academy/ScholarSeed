import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  INITIAL_OFFICE_WARMUP_STATUS,
  officeWarmupProgress,
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
  const failed: OfficeWarmupStatus = { ...INITIAL_OFFICE_WARMUP_STATUS, stage: 'error' }
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
  assert.match(warmupSource, /<IconButton[\s\S]*label=\{t\('officeDocument\.close'\)\}[\s\S]*onClick=\{\(\) => setDismissedError\(true\)\}/)
})

test('retry rebuilds the WASM frame and enables progress', () => {
  assert.equal(shouldShowOfficeWarmup(INITIAL_OFFICE_WARMUP_STATUS, true), true)
  assert.equal(shouldShowOfficeWarmupProgress(INITIAL_OFFICE_WARMUP_STATUS, true), true)
  assert.match(runtimeSource, /setFrameEpoch\(epoch => epoch \+ 1\)/)
  assert.match(runtimeSource, /setShowWarmupProgress\(true\)/)
})
