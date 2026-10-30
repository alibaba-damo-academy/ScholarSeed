import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMathDelimiters } from './mathematics.ts'

test('serialized bracket citation labels remain links rather than display math', () => {
  const source = String.raw`[\[1\]](#ref-paper)`
  for (const type of ['link', 'linkReference']) {
    const tree = {
      type: 'root',
      children: [
        {
          type,
          position: { start: { offset: 0 }, end: { offset: source.length } },
        },
      ],
    }
    assert.equal(normalizeMathDelimiters(source, tree), source)
  }
})

test('link boundaries preserve inline math without disabling display math in prose', () => {
  const label = String.raw`[\(x\)](target)`
  const source = label + String.raw` and \[y\]`
  const tree = {
    type: 'root',
    children: [
      {
        type: 'link',
        position: { start: { offset: 0 }, end: { offset: label.length } },
      },
    ],
  }
  assert.equal(normalizeMathDelimiters(source, tree), '[$x$](target) and \n$$\ny\n$$\n')
})
