import assert from 'node:assert/strict'
import test from 'node:test'

import { absoluteSessionFilePath, relativeSessionFilePath } from './links.ts'

test('session file links accept only working-directory-relative paths', () => {
  assert.equal(relativeSessionFilePath('outputs/report.md'), 'outputs/report.md')
  assert.equal(relativeSessionFilePath('./outputs/report%20one.md'), 'outputs/report one.md')
  for (const href of [
    '', '/', '../secrets.txt', 'outputs/../secrets.txt', 'outputs//report.md',
    '/tmp/report.md', 'C:\\report.md', '\\\\host\\report.md',
    'file:///tmp/report.md', 'javascript:alert(1)', 'https://example.com/report.md',
    '%2e%2e/secrets.txt', '%2ftmp/report.md', 'outputs/%00report.md', '%invalid'
  ]) {
    assert.equal(relativeSessionFilePath(href), null, href)
  }
})

test('session file paths follow the session root platform separator', () => {
  assert.equal(absoluteSessionFilePath('/tmp/session', 'outputs/report.md'), '/tmp/session/outputs/report.md')
  assert.equal(absoluteSessionFilePath('/tmp/session/', 'outputs/report.md'), '/tmp/session/outputs/report.md')
  assert.equal(absoluteSessionFilePath('C:\\session', 'outputs/report.md'), 'C:\\session\\outputs\\report.md')
  assert.equal(absoluteSessionFilePath('C:\\session\\', 'outputs/report.md'), 'C:\\session\\outputs\\report.md')
})
