import assert from 'node:assert/strict'
import test from 'node:test'

import { assistantHeadingScope, truncateProjectName } from './heading.ts'

test('assistant heading shows scope only when fullscreen and the sidebar is absent', () => {
  for (const fullscreen of [false, true]) {
    for (const sidebarVisible of [false, true]) {
      assert.equal(
        assistantHeadingScope(fullscreen, sidebarVisible, '项目 A', false, '文献中心'),
        fullscreen && !sidebarVisible ? '项目 A' : null
      )
    }
  }
})

test('assistant heading uses global literature overview only without a project scope', () => {
  assert.equal(assistantHeadingScope(true, false, null, true, '文献中心'), '文献中心')
  assert.equal(assistantHeadingScope(true, false, null, true, 'All literature'), 'All literature')
  assert.equal(assistantHeadingScope(true, false, '会话所属项目', true, '文献中心'), '会话所属项目')
  assert.equal(assistantHeadingScope(true, false, null, false, '文献中心'), null)
  assert.equal(assistantHeadingScope(false, false, null, true, '文献中心'), null)
  assert.equal(assistantHeadingScope(true, true, null, true, '文献中心'), null)
})

test('project heading preserves ten visible characters and appends three dots only when needed', () => {
  assert.equal(truncateProjectName('项目'), '项目')
  assert.equal(truncateProjectName('1234567890'), '1234567890')
  assert.equal(truncateProjectName('12345678901'), '1234567890...')
  assert.equal(truncateProjectName('审核标签验收20260922'), '审核标签验收2026...')
  assert.equal(truncateProjectName('🧑‍🔬'.repeat(11)), `${'🧑‍🔬'.repeat(10)}...`)
  assert.equal(truncateProjectName('e\u0301'.repeat(11)), `${'e\u0301'.repeat(10)}...`)
})
