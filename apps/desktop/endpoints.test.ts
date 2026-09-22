import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RENDERER_DEV_CACHE_DIRECTORY,
  RENDERER_DEV_HOST,
  RENDERER_DEV_PORT,
  RENDERER_DEV_STRICT_PORT
} from './endpoints.ts'

test('renderer keeps its preferred port but retries when that port is occupied', () => {
  assert.equal(RENDERER_DEV_HOST, '127.0.0.1')
  assert.equal(RENDERER_DEV_PORT, 5173)
  assert.equal(RENDERER_DEV_STRICT_PORT, false)
})

test('renderer development owns a cache outside the shared Vite directory', () => {
  assert.equal(RENDERER_DEV_CACHE_DIRECTORY, 'node_modules/.vite-scholarseed-desktop')
})
