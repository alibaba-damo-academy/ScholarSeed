import assert from 'node:assert/strict'
import test from 'node:test'

import { createCrashReport } from './crash.ts'

const ENVIRONMENT = {
  devicePixelRatio: 2,
  language: 'zh-CN',
  location: 'http://localhost:5173/workbench',
  userAgent: 'ScholarSeed test agent',
  viewportHeight: 800,
  viewportWidth: 1200,
}

test('crash report includes renderer, React, and environment diagnostics', () => {
  const error = new TypeError('render failed')
  error.stack = 'TypeError: render failed\n    at BrokenView'

  const report = createCrashReport(
    error,
    '\n    at BrokenView\n    at App',
    ENVIRONMENT,
    new Date('2026-09-23T07:00:00.000Z')
  )

  assert.match(report, /Occurred at: 2026-09-23T07:00:00\.000Z/)
  assert.match(report, /Error name: TypeError/)
  assert.match(report, /Error message: render failed/)
  assert.match(report, /TypeError: render failed\n {4}at BrokenView/)
  assert.match(report, /React component stack:\n {4}at BrokenView\n {4}at App/)
  assert.match(report, /Viewport: 1200x800 @ 2x/)
  assert.match(report, /User agent: ScholarSeed test agent/)
})

test('crash report stays within the feedback description limit', () => {
  const error = new Error('render failed')
  error.stack = 'x'.repeat(10_000)

  const report = createCrashReport(error, 'y'.repeat(10_000), ENVIRONMENT, new Date(0))

  assert.equal(report.length, 5000)
})
