import { describe, expect, test } from 'bun:test'
import { DirectiveStreamHarness, visibleScholarSeedText } from './directive'

describe('ScholarSeed directive stream harness', () => {
  test('replaces cumulative snapshots without duplicating commentary', () => {
    const harness = new DirectiveStreamHarness()
    expect(harness.append('commentary', '我', true)).toBe('我')
    expect(harness.append('commentary', '我会计算。', true)).toBe('我会计算。')
    expect(harness.append('commentary', '我会计算。\n::scholarseed-preview{file="a.py"}', true)).toBe('我会计算。')
  })
  test('hides incomplete and complete control lines', () => {
    const harness = new DirectiveStreamHarness()
    expect(harness.append('s', '完成\n::scholarseed-pre')).toBe('完成')
    expect(harness.append('s', 'view{file="report.md"}')).toBe('完成')
  })

  test('preserves examples inside code fences', () => {
    const source = '```text\n::scholarseed-preview{file="report.md"}\n```'
    expect(visibleScholarSeedText(source)).toBe(source)
  })
})
