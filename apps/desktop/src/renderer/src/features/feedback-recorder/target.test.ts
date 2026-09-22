import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeTarget, targetDisplayLabel, targetLabel, targetLocatorLabel } from './target.ts'

class FakeElement {
  constructor(
    readonly tagName: string,
    readonly textContent: string,
    private readonly attributes: Readonly<Record<string, string>> = {},
    private readonly semanticParent: FakeElement | null = null,
    readonly parentElement: FakeElement | null = null
  ) {}

  closest(): FakeElement | null {
    return this.semanticParent || this
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] || null
  }

  getBoundingClientRect(): { x: number; y: number; width: number; height: number } {
    return { x: 10.4, y: 20.6, width: 100.2, height: 40.8 }
  }
}

test('target summary resolves a nested event target to its stable semantic owner', () => {
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement })
  try {
    const page = new FakeElement('SECTION', 'Projects', { 'data-testid': 'project-overview' })
    const button = new FakeElement('BUTTON', 'Open project', {
      'data-testid': 'project-open',
      role: 'button',
      'aria-label': 'Open project'
    }, null, page)
    const icon = new FakeElement('SPAN', '', {}, button)
    assert.deepEqual(summarizeTarget(icon as unknown as EventTarget), {
      tag: 'button',
      testId: 'project-open',
      role: 'button',
      ariaLabel: 'Open project',
      accessibleName: 'Open project',
      text: 'Open project',
      locator: { kind: 'testId', value: 'project-open' },
      containerTestIds: ['project-overview'],
      bounds: { x: 10, y: 21, width: 100, height: 41 }
    })
  } finally {
    delete (globalThis as Record<string, unknown>).Element
  }
})

test('target label follows stable identifier, aria, role, text and tag priority', () => {
  assert.equal(targetLabel({ tag: 'button', text: 'Open', role: 'button' }), 'button')
  assert.equal(targetLabel({ tag: 'button', text: 'Open', ariaLabel: 'Open project' }), 'Open project')
  assert.equal(targetLabel({ tag: 'button', testId: 'project-open', ariaLabel: 'Open project' }), 'project-open')
})

test('target display label favors user-facing accessible names and text', () => {
  assert.equal(
    targetDisplayLabel({
      tag: 'button',
      testId: 'activity-literature',
      ariaLabel: '文献全览',
      accessibleName: '文献全览'
    }),
    '文献全览'
  )
  assert.equal(
    targetDisplayLabel({ tag: 'button', testId: 'filter-recent', text: '最近添加 24' }),
    '最近添加 24'
  )
})

test('form controls use their associated label as the user-facing name', () => {
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement })
  try {
    const input = new FakeElement('INPUT', '') as FakeElement & {
      labels: Array<{ textContent: string }>
    }
    input.labels = [{ textContent: '项目名 *' }]
    const summary = summarizeTarget(input as unknown as EventTarget)
    assert.equal(summary.accessibleName, '项目名 *')
    assert.equal(targetDisplayLabel(summary), '项目名 *')
  } finally {
    delete (globalThis as Record<string, unknown>).Element
  }
})

test('target locator label favors durable semantic selectors over structural paths', () => {
  assert.equal(
    targetLocatorLabel({ tag: 'button', locator: { kind: 'testId', value: 'project-open' } }),
    '[data-testid="project-open"]'
  )
  assert.equal(
    targetLocatorLabel({ tag: 'button', locator: { kind: 'roleName', value: 'button\nOpen project' } }),
    'role=button, name="Open project"'
  )
})

test('native buttons receive an implicit role-name locator', () => {
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement })
  try {
    const button = new FakeElement('BUTTON', '全部 24')
    const summary = summarizeTarget(button as unknown as EventTarget)
    assert.deepEqual(summary.locator, { kind: 'roleName', value: 'button\n全部 24' })
    assert.equal(targetLocatorLabel(summary), 'role=button, name="全部 24"')
  } finally {
    delete (globalThis as Record<string, unknown>).Element
  }
})
