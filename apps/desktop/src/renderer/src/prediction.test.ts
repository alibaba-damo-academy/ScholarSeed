import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptsPrediction, predictionTurn } from './prediction.ts'

test('only unmodified Tab and Right accept an empty draft suggestion', () => {
  const key = { key: 'Tab', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
  assert.equal(acceptsPrediction(key, '', 'suggestion'), true)
  assert.equal(acceptsPrediction({ ...key, key: 'ArrowRight' }, '', 'suggestion'), true)
  assert.equal(acceptsPrediction({ ...key, shiftKey: true }, '', 'suggestion'), false)
  assert.equal(acceptsPrediction({ ...key, ctrlKey: true }, '', 'suggestion'), false)
  assert.equal(acceptsPrediction(key, 'user draft', 'suggestion'), false)
  assert.equal(acceptsPrediction(key, '', ''), false)
  assert.equal(acceptsPrediction({ ...key, key: 'Enter' }, '', 'suggestion'), false)
})

test('predictions use only the latest successfully completed turn', () => {
  assert.equal(predictionTurn({ first: 'completed', latest: 'running' }), '')
  assert.equal(predictionTurn({ first: 'completed', latest: 'failed' }), '')
  assert.equal(predictionTurn({ first: 'completed', latest: 'interrupted' }), '')
  assert.equal(predictionTurn({ first: 'completed', latest: 'completed' }), 'latest')
  assert.equal(predictionTurn(undefined), '')
})
