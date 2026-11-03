import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PreferenceDiagnostics,
  PREFERENCE_DIAGNOSTIC_PREFIX,
  parsePreferenceSubmission,
  preferenceChanges,
} from './preference-diagnostics.ts'
import { sanitizeRendererPreferences } from './preferences.ts'

test('diagnostic metadata is allowlisted and includes optional preference fields', () => {
  const metadata = {
    writerId: '12345678-1234-1234-1234-123456789012',
    submissionSources: ['state-effect'],
    changedFields: ['onboarding', 'reasoningPreferences'],
    submittedRevision: 1,
  }
  assert.deepEqual(parsePreferenceSubmission({ ...metadata, secret: 'private' }), metadata)
  for (const patch of [
    { writerId: 'private-path' },
    { submissionSources: ['private'] },
    { changedFields: ['private'] },
    { submittedRevision: -1 },
  ])
    assert.throws(() => parsePreferenceSubmission({ ...metadata, ...patch }))
  const before = sanitizeRendererPreferences({})
  const after = sanitizeRendererPreferences({
    onboarding: { seen: { home: true } },
    reasoningPreferences: { model: 'high' },
  })
  assert.ok(preferenceChanges(before, after).includes('reasoningPreferences'))
  assert.ok(preferenceChanges(before, after).includes('onboarding'))
})

test('preference diagnostics retain native error codes without settings, paths or messages', () => {
  const lines: string[] = []
  const diagnostics = new PreferenceDiagnostics('main', (line) => lines.push(line))
  const error = Object.assign(new Error('secret C:\\Users\\private\\document.docx'), {
    code: 'ERR_LEASE_NATIVE',
    systemCode: 5,
    errno: -13,
    syscall: 'open',
    path: '/Users/private/settings.json',
    token: 'private-token',
    stack: 'Error: private-token\n    at save (C:\\Users\\private\\index.js:123:45)',
  })
  assert.throws(
    () =>
      diagnostics.runSync('acquire', () => {
        throw error
      }),
    (caught) => caught === error
  )
  const record = JSON.parse(lines[0].slice(PREFERENCE_DIAGNOSTIC_PREFIX.length))
  assert.equal(record.stage, 'acquire')
  assert.equal(record.source, 'main')
  assert.equal(record.error.code, 'ERR_LEASE_NATIVE')
  assert.equal(record.error.systemCode, 5)
  assert.equal(record.error.errno, -13)
  assert.deepEqual(record.error.frames, [{ line: 123, column: 45 }])
  assert.doesNotMatch(lines.join(''), /secret|private|Users|document|token|settings/)
})

test('async failures, nested causes and recovery remain observable without changing results', async () => {
  const lines: string[] = []
  const diagnostics = new PreferenceDiagnostics('renderer', (line) => lines.push(line))
  const cause = Object.assign(new Error('private'), { code: 'EACCES' })
  const error = new AggregateError([cause], 'private', { cause })
  await assert.rejects(
    diagnostics.run('save', async () => {
      throw error
    }),
    (caught) => caught === error
  )
  assert.equal(await diagnostics.run('reconcile', async () => 42), 42)
  diagnostics.completed('reconcile')
  const records = lines.map((line) => JSON.parse(line.slice(PREFERENCE_DIAGNOSTIC_PREFIX.length)))
  assert.equal(records.length, 2)
  assert.equal(records[0].error.causes[0].code, 'EACCES')
  assert.equal(records[0].attempt, records[1].attempt)
  assert.equal(records[1].result, 'completed')
})

test('logging failures never replace a persistence failure or break successful operations', async () => {
  const diagnostics = new PreferenceDiagnostics('main', () => {
    throw Error('logging unavailable')
  })
  const error = Error('original')
  assert.throws(
    () =>
      diagnostics.runSync('write', () => {
        throw error
      }),
    (caught) => caught === error
  )
  await assert.rejects(
    diagnostics.run('apply', async () => {
      throw error
    }),
    (caught) => caught === error
  )
  assert.equal(
    diagnostics.runSync('read', () => 42),
    42
  )
  diagnostics.completed('read')
})

test('untrusted errors and cyclic causes are bounded and never serialized verbatim', () => {
  const lines: string[] = []
  const diagnostics = new PreferenceDiagnostics('main', (line) => lines.push(line))
  const error = Object.assign(new Error('private'), {
    code: 'PRIVATE_TOKEN',
    name: 'private',
    syscall: 'private',
  })
  error.cause = error
  assert.throws(() =>
    diagnostics.runSync('read', () => {
      throw error
    })
  )
  assert.doesNotMatch(lines[0], /private|PRIVATE_TOKEN/)
  assert.ok(lines[0].length < 2000)
})
