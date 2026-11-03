import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewConfiguration, PreviewConfigurationError, PREVIEW_FILE_SETTINGS } from './configuration.ts'

const SCAN = { status: 'idle' as const, projects: 1, managed: 3, created: 0, ignored: 0, oversized: 0, unsupported: 1, failed: 0 }
const POLICY = { mode: 'blacklist' as const, max_versions_per_file: 25, max_file_size_kb: 2048, include_patterns: [' *.md ', '', '*.py', '*.md'], ignore_patterns: [' *.bak '] }

test('file policy configure persists canonical settings but makes no retention or scan claim', async () => {
  const owner = new PreviewConfiguration()
  const other = new PreviewConfiguration()
  const initial = owner.read(SCAN)
  const input = structuredClone(POLICY)
  const result = await owner.configure(input)
  assert.deepEqual(result, { ...POLICY, include_patterns: ['*.md', '*.py', '*.md'], ignore_patterns: ['*.bak'], migration_required: false, added_files: 0, removed_files: 0, added_paths: [], removed_paths: [], delete_versions: 0, delete_deliveries: 0, affected_files: 0, token: '' })
  input.include_patterns.push('changed-input')
  result.include_patterns.push('changed-output')
  assert.deepEqual(owner.read(SCAN), { ...initial, ...POLICY, include_patterns: ['*.md', '*.py', '*.md'], ignore_patterns: ['*.bak'] })
  assert.deepEqual(other.read(SCAN), initial)
  const multiline = await owner.configure({ ...POLICY, include_patterns: '*.md\r\n*.py\n\n', ignore_patterns: '\n*.tmp ', max_file_size_kb: undefined })
  assert.deepEqual(multiline.include_patterns, ['*.md', '*.py'])
  assert.equal(multiline.max_file_size_kb, POLICY.max_file_size_kb)
  const read = owner.read(SCAN)
  read.scan_summary.managed = 900
  read.include_patterns.length = 0
  assert.equal(owner.read(SCAN).scan_summary.managed, SCAN.managed)
  assert.deepEqual(owner.read(SCAN).include_patterns, ['*.md', '*.py'])
})

test('file policy validates real limits before consuming fail-once and refuses retention token application', async () => {
  const owner = new PreviewConfiguration({ write: 'fail-once' })
  const initial = owner.read(SCAN)
  for (const [input, code] of [
    [{ ...POLICY, max_versions_per_file: true }, 'invalid_version_limit'],
    [{ ...POLICY, max_versions_per_file: 1.5 }, 'invalid_version_limit'],
    [{ ...POLICY, max_versions_per_file: 0 }, 'invalid_max_versions'],
    [{ ...POLICY, max_versions_per_file: 1001 }, 'invalid_max_versions'],
    [{ ...POLICY, max_file_size_kb: 0 }, 'invalid_max_file_size'],
    [{ ...POLICY, max_file_size_kb: PREVIEW_FILE_SETTINGS.maxSizeKb + 1 }, 'invalid_max_file_size'],
    [{ ...POLICY, mode: 'unknown' }, 'invalid_version_mode'],
    [{ ...POLICY, include_patterns: [42] }, 'invalid_version_patterns'],
    [{ ...POLICY, preview_token: '' }, PREVIEW_FILE_SETTINGS.unsupported],
  ] as const) await assert.rejects(owner.configure(input), { message: code })
  await assert.rejects(owner.configure(POLICY), (error: unknown) => error instanceof PreviewConfigurationError && error.status === 503 && error.message === PREVIEW_FILE_SETTINGS.writeFailure)
  assert.deepEqual(owner.read(SCAN), initial)
  assert.equal((await owner.configure(POLICY)).max_versions_per_file, POLICY.max_versions_per_file)
  assert.equal((await owner.configure({ ...POLICY, max_versions_per_file: 1000, max_file_size_kb: PREVIEW_FILE_SETTINGS.maxSizeKb })).max_versions_per_file, 1000)
})

test('file delayed writes preserve old settings until completion and cannot commit after reset or abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewConfiguration({ write: 'delayed' })
  const initial = owner.read(SCAN)
  const first = owner.configure(POLICY)
  context.mock.timers.tick(PREVIEW_FILE_SETTINGS.delayMs - 1)
  assert.deepEqual(owner.read(SCAN), initial)
  context.mock.timers.tick(1)
  await first
  assert.equal(owner.read(SCAN).max_versions_per_file, POLICY.max_versions_per_file)
  const abort = new AbortController()
  const cancelled = assert.rejects(owner.configure({ ...POLICY, max_versions_per_file: 17 }, abort.signal), { message: PREVIEW_FILE_SETTINGS.disposed })
  abort.abort()
  await cancelled
  assert.equal(owner.read(SCAN).max_versions_per_file, POLICY.max_versions_per_file)
  const oldWrite = assert.rejects(owner.configure(POLICY), { message: PREVIEW_FILE_SETTINGS.disposed })
  owner.dispose()
  context.mock.timers.tick(PREVIEW_FILE_SETTINGS.delayMs)
  await oldWrite
  await assert.rejects(owner.configure(POLICY), { message: PREVIEW_FILE_SETTINGS.disposed })
  assert.throws(() => owner.read(SCAN), { message: PREVIEW_FILE_SETTINGS.disposed })
  assert.deepEqual(new PreviewConfiguration().read(SCAN), initial)
})
