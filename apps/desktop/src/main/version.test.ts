import assert from 'node:assert/strict'
import test from 'node:test'

import { clientVersion, isNewerRelease, STARTUP_BUILD_NUMBER, startupBuildNumber } from './version.ts'

test('feedback version includes the packaged build number', () => {
  assert.equal(clientVersion('0.2.0', '202609221743'), '0.2.0-202609221743')
})

test('local feedback uses the same stable startup build number as the desktop', () => {
  const expected = `0.2.0-${STARTUP_BUILD_NUMBER}`
  assert.match(STARTUP_BUILD_NUMBER, /^\d{12}$/)
  assert.equal(clientVersion('0.2.0', ''), expected)
  assert.equal(clientVersion('0.2.0', ''), expected)
})

test('startup build number uses Beijing time across year and midnight boundaries', () => {
  assert.equal(startupBuildNumber(new Date('2026-09-14T04:30:59Z')), '202609141230')
  assert.equal(startupBuildNumber(new Date('2026-12-31T16:00:00Z')), '202701010000')
})

// The CICD contract orders releases by SemVer first and the Beijing build stamp
// second, so a rebuild of the same version is still an update.
test('a newer build of the same version outranks the installed one', () => {
  assert.equal(
    isNewerRelease(
      { version: '0.1.1', buildNumber: '202607171513' },
      { version: '0.1.1', buildNumber: '202607181200' }
    ),
    true
  )
})

test('an older build offered as an update is rejected', () => {
  assert.equal(
    isNewerRelease(
      { version: '0.1.1', buildNumber: '202607241053' },
      { version: '0.1.1', buildNumber: '202607201511' }
    ),
    false
  )
})

test('the same build is not an update', () => {
  assert.equal(
    isNewerRelease(
      { version: '0.1.1', buildNumber: '202607171513' },
      { version: '0.1.1', buildNumber: '202607171513' }
    ),
    false
  )
})

test('SemVer dominates the build stamp in both directions', () => {
  assert.equal(
    isNewerRelease(
      { version: '0.1.9', buildNumber: '202607241053' },
      { version: '0.1.10', buildNumber: '202601010000' }
    ),
    true
  )
  assert.equal(
    isNewerRelease(
      { version: '0.10.0', buildNumber: '202601010000' },
      { version: '0.9.0', buildNumber: '202612312359' }
    ),
    false
  )
  assert.equal(
    isNewerRelease(
      { version: '0.1.1', buildNumber: '202612312359' },
      { version: '0.2.0', buildNumber: '202601010000' }
    ),
    true
  )
})

test('an unrankable pair is left to the update service', () => {
  assert.equal(isNewerRelease({ version: '0.1.1-preview', buildNumber: '202607171513' },
    { version: '0.1.1', buildNumber: '202607171513' }), null)
  assert.equal(isNewerRelease({ version: '0.1.1', buildNumber: '' },
    { version: '0.1.1', buildNumber: '202607171513' }), null)
  assert.equal(isNewerRelease({ version: '0.1.1', buildNumber: '202607171513' },
    { version: 'v0.1_202607171513', buildNumber: '202607171513' }), null)
})
