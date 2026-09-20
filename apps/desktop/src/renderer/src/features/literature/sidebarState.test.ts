import assert from 'node:assert/strict'
import test from 'node:test'
import { readSidebarState, writeSidebarState } from './sidebarState.ts'

const CURRENT = 'scholarseed.literature.sidebar.v1.'
const LEGACY = 'shushen.literature.sidebar.v1.'

function storage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
}

test('legacy false and collection values migrate without losing state', () => {
  for (const value of [false, [], ['collection-one']]) {
    const target = storage({ [LEGACY + 'state']: JSON.stringify(value) })
    assert.deepEqual(readSidebarState('state', target), value)
    assert.equal(target.getItem(CURRENT + 'state'), JSON.stringify(value))
    assert.equal(target.getItem(LEGACY + 'state'), null)
    assert.deepEqual(readSidebarState('state', target), value)
  }
})

test('existing new state wins over legacy state', () => {
  const target = storage({ [CURRENT + 'state']: 'false', [LEGACY + 'state']: 'true' })
  assert.equal(readSidebarState('state', target), false)
  writeSidebarState('state', true, target)
  assert.equal(target.getItem(CURRENT + 'state'), 'true')
  assert.equal(target.getItem(LEGACY + 'state'), null)
})

test('failed migration preserves readable legacy data', () => {
  const target = storage({ [LEGACY + 'state']: 'false' })
  target.setItem = () => { throw new Error('quota') }
  assert.equal(readSidebarState('state', target), false)
  assert.equal(target.getItem(LEGACY + 'state'), 'false')
  assert.equal(target.getItem(CURRENT + 'state'), null)
})

test('unavailable or malformed storage remains nonfatal', () => {
  assert.equal(readSidebarState('state', storage()), null)
  const malformed = storage({ [LEGACY + 'state']: 'invalid json' })
  assert.equal(readSidebarState('state', malformed), null)
  assert.equal(malformed.getItem(LEGACY + 'state'), 'invalid json')
  const denied = storage()
  denied.getItem = () => { throw new Error('denied') }
  assert.equal(readSidebarState('state', denied), null)
})
