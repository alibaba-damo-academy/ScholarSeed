import assert from 'node:assert/strict'
import test from 'node:test'

import { tooltipContentClassName, tooltipStyleClassName } from './classes.ts'

test('tooltip keeps its trigger in normal stacking order', () => {
  const rootClasses = tooltipStyleClassName().split(/\s+/)

  assert.ok(rootClasses.includes('relative'))
  assert.ok(rootClasses.includes('inline-flex'))
  assert.ok(!rootClasses.some(className => className.startsWith('z-') || className.includes('z-index')))
})

test('tooltip content retains its elevated layer', () => {
  assert.ok(tooltipContentClassName.split(/\s+/).includes('z-[var(--vds-tooltip-z-index)]'))
})
