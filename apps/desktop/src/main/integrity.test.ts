import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyIntegrityOutput, processIntegrityLevel } from './integrity.ts'

test('whoami /groups 输出按强制标签 SID 分类', () => {
  assert.equal(
    classifyIntegrityOutput('Mandatory Label\\High Mandatory Level S-1-16-12288'),
    'high'
  )
  assert.equal(
    classifyIntegrityOutput('Mandatory Label\\Medium Mandatory Level S-1-16-8192'),
    'medium'
  )
  assert.equal(classifyIntegrityOutput('no mandatory label here'), 'unknown')
})

test('非 Windows 一律 n/a', () => {
  assert.equal(processIntegrityLevel('darwin'), 'n/a')
  assert.equal(processIntegrityLevel('linux'), 'n/a')
})
