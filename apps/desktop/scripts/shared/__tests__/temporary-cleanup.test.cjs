const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { removeTemporary } = require('../temporary-cleanup.cjs')

test('permanent errors fail promptly; sharing errors retry without changing permissions', t => {
  let calls = 0
  t.mock.method(fs, 'rmSync', () => { calls++; throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  assert.throws(() => removeTemporary('/not-owned', 1000), /denied/)
  assert.equal(calls, 1)
})

test('transient sharing failure retries and successful cleanup ends the loop', t => {
  let calls = 0
  t.mock.method(fs, 'rmSync', () => { if (++calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })
  removeTemporary('/not-owned', 1000)
  assert.equal(calls, 2)
})
