import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resourceListingRows,
  suggestionPosition,
  suggestionSize,
  sourceNeedsDisclosure,
} from './utils.ts'
import type { ResourceNode } from './state.ts'

test('resource time sorting preserves hierarchy and leaves missing dates last', () => {
  const nodes: ResourceNode[] = [
    { path: 'folder', name: 'folder', kind: 'dir', updatedAt: 2 },
    { path: 'folder/new', name: 'new', kind: 'file', updatedAt: 9 },
    { path: 'folder/old', name: 'old', kind: 'file', updatedAt: 1 },
    { path: 'missing', name: 'missing', kind: 'file' },
    { path: 'root', name: 'root', kind: 'file', updatedAt: 3 },
  ]
  const names = (ascending: boolean) =>
    resourceListingRows(nodes, { folder: true }, undefined, ascending).map(({ node }) => node.name)
  assert.deepEqual(names(true), ['folder', 'old', 'new', 'root', 'missing'])
  assert.deepEqual(names(false), ['root', 'folder', 'new', 'old', 'missing'])
  assert.equal(nodes[1].name, 'new')
})

test('flat resource listing respects folder hierarchy and expansion', () => {
  const nodes: ResourceNode[] = [
    { path: 'resources/aa/123.md', name: '123.md', kind: 'file' },
    { path: 'resources/aa/nested/deep.md', name: 'deep.md', kind: 'file' },
    { path: 'resources/aa/nested', name: 'nested', kind: 'dir' },
    { path: 'resources/aa', name: 'aa', kind: 'dir' },
    { path: 'resources/root.md', name: 'root.md', kind: 'file' },
  ]
  const project = (expanded: Record<string, boolean>, matches?: Set<string>) =>
    resourceListingRows(nodes, expanded, matches).map(({ node, depth }) => [node.name, depth])
  assert.deepEqual(project({}), [
    ['aa', 0],
    ['root.md', 0],
  ])
  assert.deepEqual(project({ 'resources/aa': true }), [
    ['aa', 0],
    ['123.md', 1],
    ['nested', 1],
    ['root.md', 0],
  ])
  assert.deepEqual(project({ 'resources/aa': true, 'resources/aa/nested': true }), [
    ['aa', 0],
    ['123.md', 1],
    ['nested', 1],
    ['deep.md', 2],
    ['root.md', 0],
  ])
  assert.deepEqual(project({}, new Set(['resources/aa/nested/deep.md'])), [
    ['aa', 0],
    ['nested', 1],
    ['deep.md', 2],
  ])
})

test('suggestion resizes both dimensions while keeping its origin', () => {
  assert.deepEqual(
    suggestionSize(
      { width: 670, height: 510 },
      { left: 100, top: 100 },
      { width: 1280, height: 840 }
    ),
    { width: 670, height: 510 }
  )
  assert.deepEqual(
    suggestionSize(
      { width: 100, height: 100 },
      { left: 100, top: 100 },
      { width: 1280, height: 840 }
    ),
    { width: 390, height: 260 }
  )
})

test('suggestion resize never crosses the viewport even when smaller than its minimum', () => {
  assert.deepEqual(
    suggestionSize(
      { width: 900, height: 900 },
      { left: 700, top: 500 },
      { width: 1280, height: 840 }
    ),
    { width: 568, height: 328 }
  )
  assert.deepEqual(
    suggestionSize({ width: 520, height: 500 }, { left: 12, top: 12 }, { width: 320, height: 240 }),
    { width: 296, height: 216 }
  )
})

test('suggestion uses its measured height near the viewport bottom', () => {
  assert.deepEqual(
    suggestionPosition(
      { left: 800, top: 520 },
      { width: 520, height: 368.5 },
      { width: 1280, height: 840 }
    ),
    { left: 748, top: 459.5 }
  )
})

test('suggestion reclamps measured dimensions after growth, dragging and viewport shrink', () => {
  assert.deepEqual(
    suggestionPosition(
      { left: -30, top: -90 },
      { width: 400, height: 350 },
      { width: 600, height: 500 }
    ),
    { left: 12, top: 12 }
  )
  assert.deepEqual(
    suggestionPosition(
      { left: 748, top: 459.5 },
      { width: 520, height: 440 },
      { width: 800, height: 600 }
    ),
    { left: 268, top: 148 }
  )
  assert.deepEqual(
    suggestionPosition(
      { left: 100, top: 100 },
      { width: 376, height: 276 },
      { width: 400, height: 300 }
    ),
    { left: 12, top: 12 }
  )
})

test('source disclosure uses rendered lines including soft wrapping', () => {
  assert.equal(sourceNeedsDisclosure(84, 28), false)
  assert.equal(sourceNeedsDisclosure(56, 28), false)
  assert.equal(sourceNeedsDisclosure(112, 28), true)
})
