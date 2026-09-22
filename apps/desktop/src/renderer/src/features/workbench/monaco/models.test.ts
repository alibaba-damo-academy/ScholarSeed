import assert from 'node:assert/strict'
import test from 'node:test'

import { sweepModels } from './models.ts'

test('model sweep disposes only sessions without live tab references', () => {
  const disposed: string[] = []
  const models = new Map([
    ['live', { dispose: () => disposed.push('live') }],
    ['closed', { dispose: () => disposed.push('closed') }]
  ])

  sweepModels(models, new Set(['live']))

  assert.deepEqual(disposed, ['closed'])
  assert.deepEqual([...models.keys()], ['live'])
})
