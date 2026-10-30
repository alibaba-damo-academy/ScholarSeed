import assert from 'node:assert/strict'
import test from 'node:test'
import { redactUpdateLog } from './redaction.ts'

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
