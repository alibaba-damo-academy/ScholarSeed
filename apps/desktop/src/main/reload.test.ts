import assert from 'node:assert/strict'
import test from 'node:test'

import { blocksRendererReload, prepareRendererLoad } from './reload.ts'

test('blocks product reload accelerators without consuming ordinary typing', () => {
  assert.equal(blocksRendererReload({ key: 'r', meta: true, control: false, shift: false }), true)
  assert.equal(blocksRendererReload({ key: 'R', meta: true, control: false, shift: true }), true)
  assert.equal(blocksRendererReload({ key: 'r', meta: false, control: true, shift: false }), true)
  assert.equal(blocksRendererReload({ key: 'r', meta: false, control: false, shift: false }), false)
  assert.equal(blocksRendererReload({ key: 's', meta: true, control: false, shift: false }), false)
})

test('clears Chromium cache only before a development renderer load', async () => {
  let clears = 0
  const clearCache = async (): Promise<void> => { clears += 1 }

  assert.equal(await prepareRendererLoad('http://localhost:5173/', clearCache), true)
  assert.equal(await prepareRendererLoad(undefined, clearCache), false)
  assert.equal(clears, 1)
})
