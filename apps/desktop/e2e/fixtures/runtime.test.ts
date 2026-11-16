import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestInfo } from '@playwright/test'
import { ONBOARDING_GROUPS } from '../../src/onboarding.ts'
import {
  assertRuntimeSourceOwnership,
  createRuntime,
  runtimeHomeRoot,
  seedLiveConfig,
  withIsolatedRuntime,
  type RuntimePaths,
} from './runtime.ts'

test('isolated E2E user starts with completed onboarding unless a spec overrides it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-preferences-test-'))
  let home = ''
  try {
    const runtime = createRuntime({
      outputPath: (name: string) => join(directory, name),
    } as TestInfo)
    home = runtime.home
    assert.equal(runtime.workspace, join(runtime.home, 'workspace'))
    assert.equal(existsSync(runtime.workspace), true)
    const preferences = JSON.parse(
      readFileSync(join(runtime.userData, 'renderer-preferences.json'), 'utf8')
    )
    assert.equal(preferences.language, 'zh')
    assert.deepEqual(
      preferences.onboarding.seen,
      Object.fromEntries(ONBOARDING_GROUPS.map((group) => [group, true]))
    )
  } finally {
    if (home) rmSync(home, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('owned sources remain valid across cases without reusing their old output directories', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-owner-test-'))
  const runtime = createRuntime({ outputPath: (name: string) => join(directory, name) } as TestInfo)
  context.after(() => {
    rmSync(runtime.home, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })
  const ownerPath = join(runtime.home, '.e2e-owner.json')
  const original = readFileSync(ownerPath)
  rmSync(runtime.root, { recursive: true, force: true })
  assert.doesNotThrow(() => assertRuntimeSourceOwnership(runtime.home, runtime.workspace))
  assert.deepEqual(readFileSync(ownerPath), original)
  assert.equal(existsSync(runtime.root), false)
})

test('source validation rejects missing and malformed ownership without adopting the home', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-owner-invalid-'))
  const runtime = createRuntime({ outputPath: (name: string) => join(directory, name) } as TestInfo)
  context.after(() => {
    rmSync(runtime.home, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })
  const ownerPath = join(runtime.home, '.e2e-owner.json')
  const adoptionPath = join(runtime.home, '.adopted-from-veda')
  const owner = readFileSync(ownerPath)
  const adoption = readFileSync(adoptionPath)
  rmSync(ownerPath)
  assert.throws(() => assertRuntimeSourceOwnership(runtime.home, runtime.workspace))
  assert.equal(existsSync(ownerPath), false)
  for (const value of [
    'not JSON',
    'null',
    '[]',
    '{}',
    JSON.stringify({ root: 'relative', artifacts: runtime.artifacts }),
    JSON.stringify({ root: runtime.root, artifacts: join(directory, 'foreign-output') }),
  ]) {
    writeFileSync(ownerPath, value)
    assert.throws(() => assertRuntimeSourceOwnership(runtime.home, runtime.workspace))
    assert.equal(readFileSync(ownerPath, 'utf8'), value)
  }
  writeFileSync(ownerPath, owner)
  rmSync(adoptionPath)
  assert.throws(() => assertRuntimeSourceOwnership(runtime.home, runtime.workspace))
  assert.equal(existsSync(adoptionPath), false)
  writeFileSync(adoptionPath, 'not an isolated Playwright runtime')
  assert.throws(() => assertRuntimeSourceOwnership(runtime.home, runtime.workspace))
  writeFileSync(adoptionPath, adoption)
  assert.doesNotThrow(() => assertRuntimeSourceOwnership(runtime.home, runtime.workspace))
})

test('source validation rejects another workspace or a linked root without modifying either', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-owner-paths-'))
  const runtime = createRuntime({ outputPath: (name: string) => join(directory, name) } as TestInfo)
  context.after(() => {
    rmSync(directory, { recursive: true, force: true })
    rmSync(runtime.home, { recursive: true, force: true })
  })
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  const sentinel = join(outside, 'keep.txt')
  writeFileSync(sentinel, 'unchanged')
  const homeLink = join(directory, 'home-link')
  const workspaceLink = join(runtime.home, 'workspace-link')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(runtime.home, homeLink, linkType)
  symlinkSync(outside, workspaceLink, linkType)
  for (const [home, workspace] of [
    [runtime.home, outside],
    [runtime.home, runtime.home],
    [homeLink, runtime.workspace],
    [runtime.home, workspaceLink],
    ['relative-home', runtime.workspace],
    [runtime.home, 'relative-workspace'],
  ])
    assert.throws(() => assertRuntimeSourceOwnership(home, workspace))
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged')
})

test('isolated E2E home uses native Windows temp instead of POSIX socket fallback', () => {
  const windowsTemp = 'C:\\Users\\runner\\AppData\\Local\\Temp'
  assert.equal(runtimeHomeRoot('win32', windowsTemp), windowsTemp)
  assert.equal(
    runtimeHomeRoot('darwin', '/very/long/path/for/temporary/playwright/runtime/state'),
    '/tmp'
  )
  assert.equal(runtimeHomeRoot('darwin', '/tmp'), '/tmp')
  assert.equal(
    runtimeHomeRoot('darwin', '/private/tmp/deep_rd_dev/test'),
    '/private/tmp/deep_rd_dev/test'
  )
})

test('real model profiles are copied into the isolated E2E home', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seed-live-config-test-'))
  const previous = process.env.SCHOLARSEED_REAL_HOME
  try {
    const source = join(directory, 'source')
    const home = join(directory, 'home')
    mkdirSync(source)
    mkdirSync(home)
    writeFileSync(
      join(source, 'config.json'),
      JSON.stringify({ selected_model_key: 'personal-test:model' })
    )
    writeFileSync(
      join(source, 'model_profiles.json'),
      JSON.stringify({ profiles: { 'personal-test': {} } })
    )
    process.env.SCHOLARSEED_REAL_HOME = source
    const paths = { home } as RuntimePaths
    assert.equal(seedLiveConfig(paths), null)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'model_profiles.json'), 'utf8')), {
      profiles: { 'personal-test': {} },
    })
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
    await assert.rejects(
      withIsolatedRuntime(
        { outputPath: (name: string) => join(directory, name) } as TestInfo,
        async (runtime) => {
          home = runtime.home
          throw new Error('preflight failed')
        }
      ),
      /preflight failed/
    )
    assert.equal(home.length > 0, true)
    assert.equal(existsSync(home), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
