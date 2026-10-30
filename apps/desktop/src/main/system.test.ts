import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSystemVersion } from './system.ts'

test('system version preserves macOS version and Apple Silicon architecture', () => {
  assert.equal(formatSystemVersion('Darwin', '26.0.1', 'arm64'), 'macOS 26.0.1 (arm64)')
})

test('system version preserves Windows build and architecture', () => {
  assert.equal(formatSystemVersion('Windows_NT', '10.0.26100', 'x64'), 'Windows 10.0.26100 (x64)')
})

test('other operating systems retain their native name', () => {
  assert.equal(formatSystemVersion('Linux', '6.8.0', 'x64'), 'Linux 6.8.0 (x64)')
})
