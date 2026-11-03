import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  captureEnvironment,
  captureSeedSource,
  findExecutableOnPath,
  mergeExecutablePaths,
  pythonExecutableDirectories,
  parseLoginShellPath,
  protocolClientArguments,
  resolveDeveloperToolsEnabled,
  resolvePreferredExecutable,
  requiresSingleInstanceLock,
  standardExecutablePath,
} from './environment.ts'

test('Python search includes the interpreter separately from Windows console scripts', () => {
  assert.deepEqual(
    pythonExecutableDirectories(
      'C:\\Runtime\\python\\python.exe',
      'C:\\Runtime\\python\\Scripts',
      'win32'
    ),
    ['C:\\Runtime\\python\\Scripts', 'C:\\Runtime\\python']
  )
  assert.deepEqual(
    pythonExecutableDirectories('/runtime/python/bin/python3', '/runtime/python/bin', 'darwin'),
    ['/runtime/python/bin']
  )
})

test('environment observation preserves Windows duplicate and absent value semantics', () => {
  const source = { Path: 'later', PATH: undefined, Empty: '', TOKEN: 'a=b', token: 'other' }
  const windows = captureEnvironment(source, 'win32')
  assert.deepEqual(windows, { Empty: '', TOKEN: 'a=b' })
  assert.deepEqual(captureEnvironment(source, 'darwin'), {
    Path: 'later',
    Empty: '',
    TOKEN: 'a=b',
    token: 'other',
  })
  source.TOKEN = 'changed'
  assert.equal(windows.TOKEN, 'a=b')
  assert.equal(Object.isFrozen(windows), true)
})

test('environment observation agrees with a real child process', async () => {
  const prefix = 'SS_CAPTURE_'
  const env = {
    ...process.env,
    SS_CAPTURE_VALUE: 'original=中文',
    ss_capture_value: 'lowercase',
    SS_CAPTURE_EMPTY: '',
    SS_CAPTURE_ABSENT: undefined,
    ss_capture_absent: 'lowercase present only on POSIX',
  }
  const running = promisify(execFile)(
    process.execPath,
    [
      '-e',
      `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith('SS_CAPTURE_')))))`,
    ],
    { env }
  )
  // execFile/spawn has synchronously normalized the private environment object.
  const captured = captureEnvironment(env)
  env.SS_CAPTURE_VALUE = 'later parent change'
  const { stdout } = await running
  assert.deepEqual(
    JSON.parse(stdout),
    Object.fromEntries(
      Object.entries(captured).filter(([key]) => key.toUpperCase().startsWith(prefix))
    )
  )
})

test('Windows protocol callbacks preserve the initiating profile', () => {
  const profile = 'C:\\Users\\Example User\\Desktop profile'
  const appPath = 'C:\\Source tree\\apps\\desktop'
  assert.deepEqual(protocolClientArguments('win32', true, appPath, profile), [
    appPath,
    `--user-data-dir=${profile}`,
  ])
  assert.deepEqual(protocolClientArguments('win32', false, appPath, profile), [
    `--user-data-dir=${profile}`,
  ])
})

test('other platforms retain their existing protocol arguments', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(protocolClientArguments(platform, true, '/source/desktop', '/profile'), [
      '/source/desktop',
    ])
    assert.deepEqual(protocolClientArguments(platform, false, '/source/desktop', '/profile'), [])
  }
})

test('enables developer tools only for an interactive Vite renderer launch', () => {
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', false, undefined), true)
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', false, '1'), true)
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', false, '0'), false)
  assert.equal(resolveDeveloperToolsEnabled(undefined, false, '1'), false)
  assert.equal(resolveDeveloperToolsEnabled(undefined, false, undefined), false)
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', true, undefined), false)
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', true, '1'), false)
})

test('interactive Vite instances also hold the profile lock for OS login callbacks', () => {
  assert.equal(requiresSingleInstanceLock(false), true)
  assert.equal(requiresSingleInstanceLock(true), false)
})

test('extracts the marked PATH from noisy login shell output', () => {
  const output = [
    'shell startup notice',
    '__SCHOLARSEED_LOGIN_PATH__/Users/test/.nvm/current/bin:/usr/bin:/bin',
    '',
  ].join('\n')
  assert.equal(parseLoginShellPath(output), '/Users/test/.nvm/current/bin:/usr/bin:/bin')
  assert.equal(parseLoginShellPath('no marker'), '')
})

test('discovers versioned NVM bins newest-first and resolves an executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'scholarseed-environment-'))
  try {
    const older = join(home, '.nvm', 'versions', 'node', 'v9.0.0', 'bin')
    const newer = join(home, '.nvm', 'versions', 'node', 'v24.16.0', 'bin')
    mkdirSync(older, { recursive: true })
    mkdirSync(newer, { recursive: true })
    const codex = join(newer, 'codex')
    writeFileSync(codex, '#!/bin/sh\n')
    chmodSync(codex, 0o755)
    const paths = standardExecutablePath(home).split(delimiter)
    assert.deepEqual(paths.slice(0, 2), [newer, older])
    assert.equal(findExecutableOnPath('codex', standardExecutablePath(home)), codex)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('merges bundled, login-shell and inherited executable paths in priority order', () => {
  assert.equal(
    mergeExecutablePaths(
      '/app/backend/bin',
      ['/Users/test/.nvm/current/bin', '/usr/bin'].join(delimiter),
      ['/usr/bin', '/bin'].join(delimiter)
    ),
    ['/app/backend/bin', '/Users/test/.nvm/current/bin', '/usr/bin', '/bin'].join(delimiter)
  )
})

test('prefers explicit Codex executable and falls back to an executable app copy', () => {
  const home = mkdtempSync(join(tmpdir(), 'scholarseed-codex-executable-'))
  try {
    const fallback = join(home, 'ChatGPT.app', 'Contents', 'Resources', 'codex')
    mkdirSync(join(fallback, '..'), { recursive: true })
    writeFileSync(fallback, '#!/bin/sh\n')
    chmodSync(fallback, 0o755)

    assert.equal(
      resolvePreferredExecutable('/custom/codex', '/bundled/codex', fallback),
      '/custom/codex'
    )
    assert.equal(resolvePreferredExecutable('', '/bundled/codex', fallback), '/bundled/codex')
    assert.equal(resolvePreferredExecutable('', '', fallback), fallback)
    assert.equal(resolvePreferredExecutable('', '', join(home, 'missing-codex')), '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('seed source retains absent, empty and overridden input without changing startup values', () => {
  const key = 'SCHOLARSEED_CONFIG_SEED_PATH'
  for (const platform of ['darwin', 'win32'] as const) {
    for (const input of [undefined, '', '../custom.json']) {
      const environment = { [key]: input }
      const source = captureSeedSource(environment, '/candidate/defaults/config.json', platform)
      assert.deepEqual(source, {
        input: input ?? null,
        packaged: '/candidate/defaults/config.json',
      })
      assert.equal(environment[key], input)
      environment[key] = 'later'
      assert.equal(source.input, input ?? null)
      assert.equal(Object.isFrozen(source), true)
    }
  }
  assert.deepEqual(captureSeedSource({ scholarseed_config_seed_path: 'external' }, null, 'win32'), {
    input: 'external',
    packaged: null,
  })
  assert.deepEqual(
    captureSeedSource(
      { SCHOLARSEED_CONFIG_SEED_PATH: undefined, scholarseed_config_seed_path: 'ignored' },
      null,
      'win32'
    ),
    { input: null, packaged: null }
  )
})

test('seed source predicts the effective value in a real spawned child', async () => {
  const key = 'SCHOLARSEED_CONFIG_SEED_PATH'
  for (const packaged of [null, join(tmpdir(), 'candidate-config.json')]) {
    const environment = { ...process.env, [key]: '../custom.json' }
    const source = captureSeedSource(environment, packaged)
    if (packaged) environment[key] = packaged
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify(process.env.SCHOLARSEED_CONFIG_SEED_PATH ?? null))',
      ],
      { env: environment }
    )
    assert.equal(JSON.parse(stdout), source.packaged ?? source.input)
    assert.equal(source.input, '../custom.json')
  }
})
