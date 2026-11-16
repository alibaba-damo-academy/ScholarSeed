import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { DirectiveStreamHarness, visibleScholarSeedText } from './directive.ts'

describe('ScholarSeed directive stream harness', () => {
  test('replaces cumulative snapshots without duplicating commentary', () => {
    const harness = new DirectiveStreamHarness()
    assert.equal(harness.append('commentary', '我', true), '我')
    assert.equal(harness.append('commentary', '我会计算。', true), '我会计算。')
    assert.equal(
      harness.append('commentary', '我会计算。\n::scholarseed-preview{file="a.py"}', true),
      '我会计算。'
    )
  })
  test('hides incomplete and complete control lines', () => {
    const harness = new DirectiveStreamHarness()
    assert.equal(harness.append('s', '完成\n::scholarseed-pre'), '完成')
    assert.equal(harness.append('s', 'view{file="report.md"}'), '完成')
  })

  test('preserves examples inside code fences', () => {
    const source = '```text\n::scholarseed-preview{file="report.md"}\n```'
    assert.equal(visibleScholarSeedText(source), source)
  })
})
