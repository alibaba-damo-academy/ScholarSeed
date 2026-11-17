import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserFailureReporter } from '../browserdiagnostics.ts'

test('browser failure diagnostics allow only protocol codes and internal identifiers, never exception bodies', () => {
  const lines: string[] = []
  const report = createBrowserFailureReporter((line) => lines.push(line))
  report(
    { source: 'tooltip', operation: 'publish', tabId: 'secret-token', revision: 3 },
    Object.assign(
      new TypeError('secret https://private.example/?token=hidden /Users/private/file'),
      { code: 'private-token' }
    )
  )
  const record = JSON.parse(lines[0].slice('[browser-failure] '.length))
  assert.equal(record.source, 'tooltip')
  assert.equal(record.operation, 'publish')
  assert.equal(record.errorName, 'TypeError')
  assert.equal(record.tabId, null)
  assert.equal(record.revision, 3)
  assert.doesNotMatch(lines.join(''), /secret|private|hidden|Users/)
  report({ source: 'viewport', operation: 'private-operation' }, 'target_closed')
  assert.match(lines[1], /"operation":"unknown"/)
  assert.match(lines[1], /"errorCode":"target_closed"/)
})

test('browser diagnostics aggregate repeated frame failures without losing other operations', () => {
  const lines: string[] = []
  let timestamp = 0
  const report = createBrowserFailureReporter(
    (line) => lines.push(line),
    () => timestamp
  )
  for (let revision = 0; revision < 100; revision += 1)
    report({ source: 'frame', operation: 'acknowledge', revision }, 'operation_failed')
  report({ source: 'command', operation: 'close' }, 'target_closed')
  assert.equal(lines.length, 2)
  timestamp = 10_000
  report({ source: 'frame', operation: 'acknowledge', revision: 101 }, 'operation_failed')
  assert.match(lines[2], /"suppressedCount":99/)
})

test('a broken diagnostic sink cannot replace the browser failure or throw into its caller', () => {
  const report = createBrowserFailureReporter(() => {
    throw new Error('disk unavailable')
  })
  assert.doesNotThrow(() =>
    report({ source: 'command', operation: 'navigate' }, 'navigation_failed')
  )
})

test('unexpected browser exceptions retain bounded code locations without exposing paths or messages', () => {
  const lines: string[] = []
  const failure = new TypeError('private-message')
  failure.stack =
    'TypeError: private-message\n    at navigate (/Users/private/repo/apps/desktop/src/main/browser.ts:631:20)\n    at /Users/private/customer-file.ts:10:2\n    at file:///C:/private/apps/desktop/out/main/index.js:2758:3'
  createBrowserFailureReporter((line) => lines.push(line))(
    { source: 'ipc', operation: 'navigate' },
    failure
  )
  const record = JSON.parse(lines[0].slice('[browser-failure] '.length))
  assert.deepEqual(record.errorLocations, ['browser.ts:631:20', 'index.js:2758:3'])
  assert.doesNotMatch(lines[0], /private|Users|customer|C:/)
})

test('packaged renderer failures retain hashed bundle locations but never their URL or query', () => {
  const lines: string[] = []
  const failure = new Error('private-message')
  failure.stack =
    'Error: private-message\n    at https://private.example/assets/index-AbCd123_.js?token=hidden:123:45\n    at C:\\private\\assets\\Browser-HaSh1234.js:67:8'
  createBrowserFailureReporter((line) => lines.push(line))(
    { source: 'command', operation: 'navigate' },
    failure
  )
  const record = JSON.parse(lines[0].slice('[browser-failure] '.length))
  assert.deepEqual(record.errorLocations, ['index-AbCd123_.js:123:45', 'Browser-HaSh1234.js:67:8'])
  assert.doesNotMatch(lines[0], /private|https|hidden|token|C:/)
})
