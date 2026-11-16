import assert from 'node:assert/strict'
import test from 'node:test'
import { pdfSelectionRefreshPending } from './analysis.ts'

test('explanation refresh tracks model changes without replacing the previous request', () => {
  const request = { model_key: 'model-a' }
  assert.equal(pdfSelectionRefreshPending(undefined, 'model-a'), false)
  assert.equal(pdfSelectionRefreshPending(request, 'model-a'), false)
  assert.equal(pdfSelectionRefreshPending(request, 'model-b'), true)
  assert.equal(pdfSelectionRefreshPending(request, 'model-a'), false)
  assert.deepEqual(request, { model_key: 'model-a' })
  assert.equal(pdfSelectionRefreshPending({ model_key: 'model-b' }, 'model-b'), false)
})
