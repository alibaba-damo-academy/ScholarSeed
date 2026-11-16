import assert from 'node:assert/strict'
import test from 'node:test'
import { citationOrigin } from './display.ts'

test('citation origins use source labels rather than article titles', () => {
  assert.deepEqual(citationOrigin('https://www.hbs.edu/paper'), { domain: 'hbs.edu', label: 'hbs' })
  assert.deepEqual(citationOrigin('https://arxiv.org/abs/123'), {
    domain: 'arxiv.org',
    label: 'arxiv',
  })
  assert.equal(citationOrigin('not a URL'), undefined)
  assert.equal(citationOrigin('file:///private/paper.pdf'), undefined)
})
