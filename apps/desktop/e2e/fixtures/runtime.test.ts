import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestInfo } from '@playwright/test'
import { ONBOARDING_GROUPS } from '../../src/onboarding.ts'
import { createRuntime, runtimeHomeRoot, seedLiveConfig, withIsolatedRuntime, type RuntimePaths } from './runtime.ts'

test('isolated E2E user starts with completed onboarding unless a spec overrides it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-preferences-test-'))
  let home = ''
  try {
    const runtime = createRuntime({ outputPath: (name: string) => join(directory, name) } as TestInfo)
    home = runtime.home
    assert.equal(runtime.workspace, join(runtime.home, 'workspace'))
    assert.equal(existsSync(runtime.workspace), true)
    const preferences = JSON.parse(readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8'))
    assert.equal(preferences.language, 'zh')
    assert.deepEqual(preferences.onboarding.seen,
      Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true])))
  } finally {
    if (home) rmSync(home, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('isolated E2E home uses native Windows temp instead of POSIX socket fallback', () => {
  const windowsTemp = 'C:\\Users\\runner\\AppData\\Local\\Temp'
  assert.equal(runtimeHomeRoot('win32', windowsTemp), windowsTemp)
  assert.equal(runtimeHomeRoot('darwin', '/very/long/path/for/temporary/playwright/runtime/state'), '/tmp')
  assert.equal(runtimeHomeRoot('darwin', '/tmp'), '/tmp')
  assert.equal(runtimeHomeRoot('darwin', '/private/tmp/deep_rd_dev/test'), '/private/tmp/deep_rd_dev/test')
})

test('real model profiles are copied into the isolated E2E home', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seed-live-config-test-'))
  const previous = process.env.SCHOLARSEED_REAL_HOME
  try {
    const source = join(directory, 'source')
    const home = join(directory, 'home')
    mkdirSync(source)
    mkdirSync(home)
    writeFileSync(join(source, 'config.json'), JSON.stringify({ selected_model_key: 'personal-test:model' }))
    writeFileSync(join(source, 'model_profiles.json'), JSON.stringify({ profiles: { 'personal-test': {} } }))
    process.env.SCHOLARSEED_REAL_HOME = source
    const paths = { home } as RuntimePaths
    assert.equal(seedLiveConfig(paths), null)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'model_profiles.json'), 'utf8')),
      { profiles: { 'personal-test': {} } })
  } finally {
    if (previous === undefined) delete process.env.SCHOLARSEED_REAL_HOME
    else process.env.SCHOLARSEED_REAL_HOME = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

test('isolated E2E home is removed when preflight fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-cleanup-test-'))
  let home = ''
  try {
    await assert.rejects(withIsolatedRuntime({ outputPath: (name: string) => join(directory, name) } as TestInfo,
      async (runtime) => {
        home = runtime.home
        throw new Error('preflight failed')
      }), /preflight failed/)
    assert.equal(home.length > 0, true)
    assert.equal(existsSync(home), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
