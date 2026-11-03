import assert from 'node:assert/strict'
import test from 'node:test'
import { redactDiagnosticError, redactUpdateLog } from './redaction.ts'

test('startup error evidence preserves native codes and bounded causes without private properties', () => {
  for (const path of ['/Users/Alice/workspace', 'C:\\Users\\Alice\\workspace']) {
    const cause = Object.assign(new Error(`EACCES ${path} access_token=private`), {
      code: 'EACCES',
      systemCode: 5,
      env: { password: 'hidden' },
    })
    const error = new Error('workspace qualification failed', { cause })
    const output = JSON.stringify(redactDiagnosticError(error))
    assert.match(output, /workspace qualification failed/)
    assert.match(output, /EACCES/)
    assert.match(output, /"systemCode":5/)
    assert.match(output, /stack/)
    assert.doesNotMatch(output, /Alice|private|hidden|password|"env"/)
    assert.equal(cause.message.includes('private'), true)
  }
  const cycle = new Error('cyclic cause')
  cycle.cause = cycle
  assert.ok(JSON.stringify(redactDiagnosticError(cycle)).length < 40_000)
  const huge = JSON.stringify(redactDiagnosticError(new Error('x'.repeat(100_000))))
  assert.ok(huge.length < 20_000)
  const native = Object.assign(new Error('directory busy'), { code: 'ERR_DOMAIN_BUSY' })
  const aggregate = JSON.stringify(
    redactDiagnosticError(
      new AggregateError(
        [native, new Error('release uncertain')],
        'Desktop writer admission failed'
      )
    )
  )
  assert.match(aggregate, /ERR_DOMAIN_BUSY/)
  assert.match(aggregate, /release uncertain/)
  assert.equal(redactDiagnosticError('Bearer credential'), 'Bearer <REDACTED>')
})

test('update diagnostic output removes transport secrets and user home identities', () => {
  const text = redactUpdateLog(
    'https://alice:password@example.com/a?token=private Authorization: Bearer credential /Users/alice/app C:\\Users\\bob\\app\n{"nonce":"abc","phase":"prepare","updateId":"123"}'
  )
  for (const secret of ['alice', 'bob', 'example.com', 'private', 'credential', 'abc'])
    assert.equal(text.includes(secret), false)
  assert.match(text, /"phase":"prepare"/)
  assert.match(text, /"updateId":"123"/)
})

test('escaped JSON secrets, Windows paths and multiple cookies are removed', () => {
  const input =
    JSON.stringify({ password: 'quoted"private', path: 'C:\\Users\\Alice Smith\\cache' }) +
    '\nCookie: first=private; second=hidden\n'
  const output = redactUpdateLog(input)
  for (const secret of ['private', 'hidden', 'Alice', 'Smith'])
    assert.equal(output.includes(secret), false)
})
