import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { DESKTOP_DIR, loadPolicy, scan } from '../scripts/ci/reuse.mjs'
import { unknownLayerTokenFindings, visualFindings } from '../scripts/ci/visual.mjs'

test('development controls obey the same zero-debt UI reuse and semantic visual constraints', () => {
  const inventory = scan({ ...loadPolicy(), scanRoot: 'preview' })
  assert.ok(inventory.files.includes('Console.tsx'))
  assert.deepEqual(inventory.counts, {})
  for (const path of inventory.files) {
    const source = readFileSync(resolve(DESKTOP_DIR, 'preview', path), 'utf8')
    assert.deepEqual(visualFindings(source, path), [], path)
    assert.deepEqual(unknownLayerTokenFindings(source, path), [], path)
  }
})
