import assert from 'node:assert/strict'
import test from 'node:test'

import { ZOTERO_LIBRARY_ROOT_KEY, type ZoteroCollectionNode } from './api.ts'
import { updateZoteroSelection, zoteroNodeState, zoteroSelectionDirectives } from './zotero.ts'

const leaf = (key: string, parentKey: string): ZoteroCollectionNode => ({
  key,
  name: key,
  parent_key: parentKey,
  direct_item_count: 1,
  subtree_item_count: 1,
  children: []
})
const first = leaf('first', ZOTERO_LIBRARY_ROOT_KEY)
const second = leaf('second', ZOTERO_LIBRARY_ROOT_KEY)
const library: ZoteroCollectionNode = {
  key: ZOTERO_LIBRARY_ROOT_KEY,
  name: 'My Library',
  parent_key: null,
  direct_item_count: 3,
  subtree_item_count: 2,
  children: [first, second]
}

test('Zotero tree selection inherits the root and reports excluded children as mixed', () => {
  const selection = new Map<string, boolean>([[ZOTERO_LIBRARY_ROOT_KEY, true], ['second', false]])
  assert.equal(zoteroNodeState(first, true, selection), true)
  assert.equal(zoteroNodeState(second, true, selection), false)
  assert.equal(zoteroNodeState(library, false, selection), 'mixed')
})

test('changing a parent removes redundant descendant directives', () => {
  const selection = updateZoteroSelection(
    new Map<string, boolean>([[ZOTERO_LIBRARY_ROOT_KEY, true], ['first', false]]),
    library,
    false
  )
  assert.deepEqual(zoteroSelectionDirectives(selection), [
    { key: ZOTERO_LIBRARY_ROOT_KEY, selected: false }
  ])
  assert.equal(zoteroNodeState(library, false, selection), false)
})
