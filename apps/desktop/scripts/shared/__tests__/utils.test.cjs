const assert = require('node:assert/strict')
const fs = require('node:fs')
const { test } = require('node:test')
const { openExecutable } = require('../utils.cjs')

function scenario(t, platform, errors) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  t.after(() => Object.defineProperty(process, 'platform', descriptor))
  const logs = []
  t.mock.method(console, 'log', line => logs.push(line))
  const wait = t.mock.method(Atomics, 'wait', () => 'timed-out')
  let calls = 0
  t.mock.method(fs, 'openSync', () => {
    const error = errors[Math.min(calls++, errors.length - 1)]
    if (error) throw error
    return 42
  })
  return { logs, wait, calls: () => calls }
}

for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`Windows retries transient ${code}`, t => {
    const state = scenario(t, 'win32', [Object.assign(new Error('locked'), { code }), null])
    assert.equal(openExecutable('ScholarSeed.exe', 'r+', 'branding.write'), 42)
    assert.equal(state.calls(), 2)
    assert.equal(state.wait.mock.calls.length, 1)
    assert.equal(JSON.parse(state.logs[0].slice('[file-open] '.length)).code, code)
  })
}
test('persistent lock fails with original error after bounded attempts', t => {
  const error = Object.assign(new Error('locked'), { code: 'EBUSY' })
  const state = scenario(t, 'win32', [error])
  assert.throws(() => openExecutable('ScholarSeed.exe', 'r+', 'branding.write'), e => e === error)
  assert.equal(state.calls(), 21)
  assert.equal(state.wait.mock.calls.length, 20)
  assert.match(state.logs.at(-1), /"event":"failed"/)
})
for (const [platform, code] of [['darwin', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'ENOSPC']]) {
  test(`${platform} ${code} fails immediately`, t => {
    const error = Object.assign(new Error(code), { code })
    const state = scenario(t, platform, [error])
    assert.throws(() => openExecutable('ScholarSeed.exe', 'r', 'branding.read'), e => e === error)
    assert.equal(state.calls(), 1)
    assert.equal(state.wait.mock.calls.length, 0)
  })
}
