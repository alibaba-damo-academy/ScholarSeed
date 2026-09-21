import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoginWindowSizing } from './window.ts'

function fixture(maximized = false) {
  const bounds = { x: 40, y: 50, width: 1400, height: 900 }
  const operations: unknown[][] = []
  const setVisible = createLoginWindowSizing({
    getNormalBounds: () => bounds,
    isMaximized: () => maximized,
    unmaximize: () => { operations.push(['unmaximize']) },
    maximize: () => { operations.push(['maximize']) },
    setMinimumSize: (width, height) => { operations.push(['minimum', width, height]) },
    setSize: (width, height) => { operations.push(['size', width, height]) },
    setBounds: (value) => { operations.push(['bounds', value]) },
    center: () => { operations.push(['center']) }
  })
  return { bounds, operations, setVisible }
}

test('login uses 900 × 600 after lowering the workspace minimum', () => {
  const { operations, setVisible } = fixture()
  setVisible(true)
  assert.deepEqual(operations, [['minimum', 900, 600], ['size', 900, 600], ['center']])
})

test('leaving login restores the user workspace bounds and minimum', () => {
  const { bounds, operations, setVisible } = fixture()
  setVisible(true)
  operations.length = 0
  setVisible(false)
  assert.deepEqual(operations, [['minimum', 1040, 660], ['bounds', bounds]])
})

test('repeated visibility notifications do not reset user window resizing', () => {
  const { operations, setVisible } = fixture()
  setVisible(false)
  assert.deepEqual(operations, [])
  setVisible(true)
  operations.length = 0
  setVisible(true)
  assert.deepEqual(operations, [])
  setVisible(false)
  operations.length = 0
  setVisible(false)
  assert.deepEqual(operations, [])
})

test('temporarily unmaximizes login and restores maximized workspace', () => {
  const { operations, setVisible } = fixture(true)
  setVisible(true)
  assert.deepEqual(operations[0], ['unmaximize'])
  setVisible(false)
  assert.deepEqual(operations.at(-1), ['maximize'])
})
