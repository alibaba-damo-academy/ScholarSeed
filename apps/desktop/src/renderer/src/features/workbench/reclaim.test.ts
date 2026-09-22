import assert from 'node:assert/strict'
import test from 'node:test'

import { reclaimDocumentResources, registerDocumentResourceReclaimer } from './reclaim.ts'

test('every registered reclaimer receives the surviving sessions and tabs', () => {
  const seen: Array<[string[], string[]]> = []
  const off = registerDocumentResourceReclaimer((sessions, tabs) => {
    seen.push([[...sessions], [...tabs]])
  })

  try {
    reclaimDocumentResources(new Set(['session-a']), new Set(['tab-a', 'tab-b']))
    assert.deepEqual(seen, [[['session-a'], ['tab-a', 'tab-b']]])
  } finally {
    off()
  }
})

test('an unregistered reclaimer stops being called', () => {
  let calls = 0
  const off = registerDocumentResourceReclaimer(() => { calls += 1 })
  reclaimDocumentResources(new Set(), new Set())
  off()
  reclaimDocumentResources(new Set(), new Set())

  assert.equal(calls, 1)
})

test('reclaiming without any loaded viewer is a no-op rather than an error', () => {
  assert.doesNotThrow(() => reclaimDocumentResources(new Set(['session-a']), new Set(['tab-a'])))
})
