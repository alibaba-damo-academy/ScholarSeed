import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import {
  findExecutableOnPath,
  mergeExecutablePaths,
  parseLoginShellPath,
  resolveDeveloperToolsEnabled,
  resolvePreferredExecutable,
  requiresSingleInstanceLock,
  standardExecutablePath
} from './environment.ts'

test('enables developer tools only for an interactive Vite renderer launch', () => {
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', false, '1'), true)
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', false, '0'), false)
  assert.equal(resolveDeveloperToolsEnabled(undefined, false, '1'), false)
  assert.equal(resolveDeveloperToolsEnabled('http://localhost:5173', true, '1'), false)
})

test('requires the interactive single-instance lock outside Vite development and headless checks', () => {
  assert.equal(requiresSingleInstanceLock(undefined, false), true)
  assert.equal(requiresSingleInstanceLock('http://127.0.0.1:5174', false), false)
  assert.equal(requiresSingleInstanceLock(undefined, true), false)
})

test('extracts the marked PATH from noisy login shell output', () => {
  const output = [
    'shell startup notice',
    '__SCHOLARSEED_LOGIN_PATH__/Users/test/.nvm/current/bin:/usr/bin:/bin',
    ''
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
    mergeExecutablePaths('/app/backend/bin', '/Users/test/.nvm/current/bin:/usr/bin', '/usr/bin:/bin'),
    '/app/backend/bin:/Users/test/.nvm/current/bin:/usr/bin:/bin'
  )
})

test('prefers explicit Codex executable and falls back to an executable app copy', () => {
  const home = mkdtempSync(join(tmpdir(), 'scholarseed-codex-executable-'))
  try {
    const fallback = join(home, 'ChatGPT.app', 'Contents', 'Resources', 'codex')
    mkdirSync(join(fallback, '..'), { recursive: true })
    writeFileSync(fallback, '#!/bin/sh\n')
    chmodSync(fallback, 0o755)

    assert.equal(resolvePreferredExecutable('/custom/codex', '/bundled/codex', fallback), '/custom/codex')
    assert.equal(resolvePreferredExecutable('', '/bundled/codex', fallback), '/bundled/codex')
    assert.equal(resolvePreferredExecutable('', '', fallback), fallback)
    assert.equal(resolvePreferredExecutable('', '', join(home, 'missing-codex')), '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
